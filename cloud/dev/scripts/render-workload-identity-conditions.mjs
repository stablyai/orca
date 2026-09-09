// Renders every Workload Identity provider `attribute_condition` exactly as
// Terraform would, so contract tests can pin the resulting strings without a
// plan. Understands only the HCL subset those expressions use.
//
// Each root is loaded on its own: the relay and apps roots both declare a provider named
// `github` while the staging copy waits on its state surgery, and only separate scopes can
// show that the two render the same string.
//
// Only the relay root ships in this repository. The apps root is still declared so this stays a
// straight copy of the private original, and is skipped when its directory is absent.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

const TERRAFORM_ROOTS = {
  relay: {
    directory: 'infra/terraform',
    sources: [
      'infra/terraform/relay-shared.tf',
      'infra/terraform/relay-github-workflow-trust.tf',
      'infra/terraform/relay-github-actions.tf',
      'infra/terraform/relay-staging-deploy-iam.tf',
      'infra/terraform/relay-asia-topology-iam.tf',
      'infra/terraform/relay-asia-proof-iam.tf'
    ]
  },
  apps: {
    directory: 'infra/terraform-apps',
    sources: ['infra/terraform-apps/github-actions.tf']
  }
}

export function hasTerraformRoot(root) {
  const directory = TERRAFORM_ROOTS[root]?.directory
  return directory !== undefined && existsSync(repoFile(directory))
}

export const TERRAFORM_ROOT_NAMES = Object.keys(TERRAFORM_ROOTS).filter(hasTerraformRoot)

const PROVIDER_RESOURCE = 'google_iam_workload_identity_pool_provider'

function repoFile(path) {
  return new URL(`../../${path}`, import.meta.url)
}

function skipTrivia(src, index) {
  let i = index
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i += 1
    if (src[i] === '#') {
      while (i < src.length && src[i] !== '\n') i += 1
      continue
    }
    return i
  }
}

// Returns the index just past the closing quote of the string starting at `i`.
function endOfString(src, i) {
  let cursor = i + 1
  while (src[cursor] !== '"') {
    if (src[cursor] === '\\') {
      cursor += 2
      continue
    }
    if (src[cursor] === '$' && src[cursor + 1] === '{') {
      cursor = endOfInterpolation(src, cursor + 2).next
      continue
    }
    cursor += 1
  }
  return cursor + 1
}

function endOfInterpolation(src, i) {
  let depth = 1
  let cursor = i
  while (depth > 0) {
    const char = src[cursor]
    if (char === undefined) throw new Error('unterminated interpolation')
    if (char === '"') {
      cursor = endOfString(src, cursor)
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) break
    }
    cursor += 1
  }
  return { text: src.slice(i, cursor), next: cursor + 1 }
}

// Stands in for a loop variable when the collection is empty: the body still has to be parsed
// once to find where it ends, and any attribute of the probe is another probe.
const PROBE = new Proxy(
  {},
  {
    get: (target, key) => (key === Symbol.toPrimitive ? () => '' : PROBE)
  }
)

function readMember(value, key) {
  if (value === PROBE) return PROBE
  if (value === null || value === undefined) throw new Error(`cannot read ${String(key)} of ${value}`)
  if (Array.isArray(value)) {
    if (typeof key !== 'number') throw new Error(`list index must be a number, got ${String(key)}`)
    if (!Number.isInteger(key) || key < 0 || key >= value.length) {
      throw new Error(`list index ${key} is out of range`)
    }
    return value[key]
  }
  if (typeof value !== 'object') throw new Error(`cannot index ${typeof value}`)
  if (!Object.hasOwn(value, key)) throw new Error(`unknown attribute ${String(key)}`)
  return value[key]
}

// [key, value] pairs the way HCL iterates: list index and element, or object key and value.
function collectionEntries(collection) {
  if (Array.isArray(collection)) return collection.map((item, index) => [index, item])
  if (collection && typeof collection === 'object') return Object.entries(collection)
  throw new Error(`cannot iterate ${typeof collection}`)
}

class ExpressionParser {
  constructor(source, scope) {
    this.source = source
    this.scope = scope
    this.index = 0
  }

  parse() {
    const value = this.parseTernary()
    this.index = skipTrivia(this.source, this.index)
    if (this.index !== this.source.length) {
      throw new Error(`trailing expression text: ${this.source.slice(this.index)}`)
    }
    return value
  }

  peek(token) {
    this.index = skipTrivia(this.source, this.index)
    return this.source.startsWith(token, this.index)
  }

  eat(token) {
    if (!this.peek(token)) return false
    this.index += token.length
    return true
  }

  expect(token) {
    if (!this.eat(token)) {
      throw new Error(`expected ${token} at ${this.source.slice(this.index, this.index + 40)}`)
    }
  }

  parseTernary() {
    const condition = this.parseOr()
    if (!this.eat('?')) return condition
    const consequent = this.parseTernary()
    this.expect(':')
    const alternate = this.parseTernary()
    return condition ? consequent : alternate
  }

  parseOr() {
    let left = this.parseAnd()
    while (this.eat('||')) left = Boolean(this.parseAnd()) || Boolean(left)
    return left
  }

  parseAnd() {
    let left = this.parseEquality()
    while (this.eat('&&')) left = Boolean(this.parseEquality()) && Boolean(left)
    return left
  }

  parseEquality() {
    let left = this.parseUnary()
    for (;;) {
      if (this.eat('==')) left = left === this.parseUnary()
      else if (this.eat('!=')) left = left !== this.parseUnary()
      else return left
    }
  }

  parseUnary() {
    return this.parsePostfix(this.parsePrimary())
  }

  parsePrimary() {
    if (this.eat('(')) {
      const value = this.parseTernary()
      this.expect(')')
      return value
    }
    if (this.peek('"')) return this.parseString()
    if (this.peek('[')) return this.parseList()
    if (this.peek('{')) return this.parseObject()
    const number = /^[0-9]+/.exec(this.source.slice(this.index))
    if (number) {
      this.index += number[0].length
      return Number(number[0])
    }
    return this.parseIdentifier()
  }

  parsePostfix(value) {
    let current = value
    for (;;) {
      if (this.eat('.')) {
        current = readMember(current, this.readWord())
        continue
      }
      if (this.peek('[')) {
        this.index += 1
        const key = this.parseTernary()
        this.expect(']')
        current = readMember(current, key)
        continue
      }
      return current
    }
  }

  // `for a in x : body` / `for a, b in x : body`, shared by list and object comprehensions.
  parseComprehension(readBody) {
    const names = [this.readWord()]
    if (this.eat(',')) names.push(this.readWord())
    this.expect('in')
    const collection = this.parseUnary()
    this.expect(':')
    const bodyStart = skipTrivia(this.source, this.index)
    const entries = collectionEntries(collection)
    const bodyParser = ([key, item]) => {
      const bindings = { ...this.scope.bindings }
      if (names.length === 1) bindings[names[0]] = Array.isArray(collection) ? item : key
      else {
        bindings[names[0]] = key
        bindings[names[1]] = item
      }
      const parser = new ExpressionParser(this.source, { ...this.scope, bindings })
      parser.index = bodyStart
      return parser
    }
    // Parse once with a probe binding to find where the body ends, because an empty
    // collection would never parse it.
    const probe = bodyParser(entries[0] ?? [PROBE, PROBE])
    readBody(probe)
    this.index = probe.index
    return entries.map((entry) => readBody(bodyParser(entry)))
  }

  parseObject() {
    this.expect('{')
    if (this.eat('for')) {
      const pairs = this.parseComprehension((parser) => {
        const key = parser.parseTernary()
        parser.expect('=>')
        return [key, parser.parseTernary()]
      })
      this.expect('}')
      return Object.fromEntries(pairs)
    }
    const object = {}
    if (this.eat('}')) return object
    for (;;) {
      const key = this.peek('"') ? this.parseString() : this.readWord()
      this.expect('=')
      object[key] = this.parseTernary()
      this.eat(',')
      if (this.eat('}')) return object
    }
  }

  parseString() {
    this.index = skipTrivia(this.source, this.index)
    const src = this.source
    let cursor = this.index + 1
    let rendered = ''
    while (src[cursor] !== '"') {
      if (src[cursor] === '\\') {
        rendered += src[cursor + 1]
        cursor += 2
        continue
      }
      if (src[cursor] === '$' && src[cursor + 1] === '{') {
        const { text, next } = endOfInterpolation(src, cursor + 2)
        rendered += String(evaluate(text, this.scope))
        cursor = next
        continue
      }
      rendered += src[cursor]
      cursor += 1
    }
    this.index = cursor + 1
    return rendered
  }

  parseList() {
    this.expect('[')
    if (this.eat('for')) {
      const items = this.parseComprehension((parser) => parser.parseTernary())
      this.expect(']')
      return items
    }
    const items = []
    if (this.eat(']')) return items
    for (;;) {
      items.push(this.parseTernary())
      if (this.eat(',')) {
        if (this.eat(']')) return items
        continue
      }
      this.expect(']')
      return items
    }
  }

  readWord() {
    this.index = skipTrivia(this.source, this.index)
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.source.slice(this.index))
    if (!match) throw new Error(`expected identifier at ${this.source.slice(this.index, this.index + 40)}`)
    this.index += match[0].length
    return match[0]
  }

  parseIdentifier() {
    const word = this.readWord()
    if (word === 'join') {
      this.expect('(')
      const separator = this.parseTernary()
      this.expect(',')
      const parts = this.parseTernary()
      this.eat(',')
      this.expect(')')
      return parts.join(separator)
    }
    if (word === 'concat') {
      this.expect('(')
      const lists = []
      for (;;) {
        lists.push(this.parseTernary())
        if (this.eat(',')) {
          if (this.eat(')')) break
          continue
        }
        this.expect(')')
        break
      }
      return lists.flat()
    }
    if (word === 'length') {
      this.expect('(')
      const value = this.parseTernary()
      this.eat(',')
      this.expect(')')
      return collectionEntries(value).length
    }
    if (word === 'local') {
      this.expect('.')
      return resolveLocal(this.readWord(), this.scope)
    }
    if (word === 'var') {
      this.expect('.')
      const name = this.readWord()
      if (!(name in this.scope.variables)) throw new Error(`unknown variable ${name}`)
      return this.scope.variables[name]
    }
    if (word in this.scope.bindings) return this.scope.bindings[word]
    if (word === 'true') return true
    if (word === 'false') return false
    throw new Error(`unsupported identifier ${word}`)
  }
}

function evaluate(source, scope) {
  return new ExpressionParser(source, scope).parse()
}

function resolveLocal(name, scope) {
  if (scope.resolved.has(name)) return scope.resolved.get(name)
  if (!scope.locals.has(name)) throw new Error(`unknown local ${name}`)
  if (scope.resolving.has(name)) throw new Error(`local cycle at ${name}`)
  scope.resolving.add(name)
  const value = evaluate(scope.locals.get(name), { ...scope, bindings: {} })
  scope.resolving.delete(name)
  scope.resolved.set(name, value)
  return value
}

function collectLocals(source, locals) {
  const blockPattern = /^locals \{$/gm
  let match
  while ((match = blockPattern.exec(source)) !== null) {
    const end = source.indexOf('\n}\n', match.index)
    const body = source.slice(match.index + match[0].length, end)
    let name = null
    let buffer = []
    const flush = () => {
      if (name) locals.set(name, buffer.join('\n'))
    }
    for (const line of body.split('\n')) {
      const assignment = /^ {2}([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
      if (assignment) {
        flush()
        name = assignment[1]
        buffer = [assignment[2]]
        continue
      }
      if (name && line.trim() !== '' && !line.trim().startsWith('#')) buffer.push(line)
    }
    flush()
  }
}

function collectProviderFields(source, fields) {
  const pattern = new RegExp(`resource "${PROVIDER_RESOURCE}" "([A-Za-z_0-9]+)" \\{`, 'g')
  let match
  while ((match = pattern.exec(source)) !== null) {
    const end = source.indexOf('\n}\n', match.index)
    const body = source.slice(match.index, end)
    const conditionStart = body.indexOf('  attribute_condition = ')
    const conditionEnd = body.indexOf('\n\n  oidc {', conditionStart)
    const countStart = body.indexOf('  count = ')
    fields.set(match[1], {
      count: body.slice(countStart + '  count = '.length, body.indexOf('\n', countStart)),
      condition: body.slice(conditionStart + '  attribute_condition = '.length, conditionEnd)
    })
  }
}

// Values that are not a plain quoted string (a list of objects, say) are read with the
// expression parser; anything it cannot evaluate is left undefined, exactly as before.
function parseValueAt(source, index) {
  const parser = new ExpressionParser(source, {
    locals: new Map(),
    variables: {},
    bindings: {},
    resolved: new Map(),
    resolving: new Set()
  })
  parser.index = index
  return parser.parseTernary()
}

function collectVariableDefaults(source, variables) {
  const pattern = /variable "([A-Za-z_0-9]+)" \{([\s\S]*?)\n\}/g
  let match
  while ((match = pattern.exec(source)) !== null) {
    const body = match[2]
    const fallback = /\n\s*default\s*=\s*"([^"]*)"/.exec(body)
    if (fallback) {
      variables[match[1]] = fallback[1]
      continue
    }
    const assignment = /\n\s*default\s*=\s*/.exec(body)
    if (!assignment) continue
    const start = match.index + match[0].indexOf(body) + assignment.index + assignment[0].length
    try {
      variables[match[1]] = parseValueAt(source, start)
    } catch {
      // A default this evaluator does not understand is not one any condition reads.
    }
  }
}

function collectTfvars(source, variables) {
  let offset = 0
  for (const line of source.split('\n')) {
    const quoted = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"\s*$/.exec(line)
    if (quoted) {
      variables[quoted[1]] = quoted[2]
      offset += line.length + 1
      continue
    }
    const structured = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?=[[{])/.exec(line)
    if (structured) {
      try {
        variables[structured[1]] = parseValueAt(source, offset + structured[0].length)
      } catch {
        // Same as above: unreadable here means unread by every condition.
      }
    }
    offset += line.length + 1
  }
}

async function loadScope(root, environment) {
  const { directory, sources } = TERRAFORM_ROOTS[root] ?? {}
  if (!sources) throw new Error(`unknown terraform root ${root}`)
  const locals = new Map()
  const providers = new Map()
  for (const path of sources) {
    const source = await readFile(repoFile(path), 'utf8')
    collectLocals(source, locals)
    collectProviderFields(source, providers)
  }
  const variables = {}
  collectVariableDefaults(await readFile(repoFile(`${directory}/variables.tf`), 'utf8'), variables)
  collectTfvars(
    await readFile(repoFile(`${directory}/environments/${environment}.tfvars`), 'utf8'),
    variables
  )
  return {
    providers,
    scope: { locals, variables, bindings: {}, resolved: new Map(), resolving: new Set() }
  }
}

// Rendered `attribute_condition` per provider that the given root creates in the environment.
export async function renderRootAttributeConditions(root, environment) {
  const { providers, scope } = await loadScope(root, environment)
  const rendered = {}
  for (const [name, fields] of providers) {
    if (evaluate(fields.count, scope) === 0) continue
    rendered[name] = evaluate(fields.condition, scope)
  }
  return rendered
}

// Every root's rendered conditions, keyed by root and then by provider.
export async function renderAttributeConditions(environment) {
  const rendered = {}
  for (const root of TERRAFORM_ROOT_NAMES) {
    rendered[root] = await renderRootAttributeConditions(root, environment)
  }
  return rendered
}

export async function readTerraformLocal(name, environment, root = 'relay') {
  const { scope } = await loadScope(root, environment)
  return resolveLocal(name, scope)
}
