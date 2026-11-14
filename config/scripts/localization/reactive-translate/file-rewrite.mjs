import path from 'node:path'
import ts from 'typescript-api'
import { SCAN_ROOT, calleeName, findI18nImports, identifierUses } from './render-path-translate.mjs'

// One file's AST-anchored text edits for the reactive-translate codemod: hook bindings in
// components/hooks, threaded helper parameters, appended call arguments and import upkeep.

const HOOK_MODULE = `${SCAN_ROOT}/i18n/use-translate`
export const HOOKS = { translate: 'useTranslate', getIntlLocale: 'useIntlLocale' }
const NAME_CANDIDATES = {
  // Catalog extraction (i18next.config.ts) only recognizes t() and translate(), so no fallback name.
  translate: ['t'],
  getIntlLocale: ['intlLocale', 'uiIntlLocale']
}

function moduleSpecifier(fromRel, targetNoExt, sf) {
  const usesAlias = sf.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.startsWith('@/')
  )
  if (usesAlias) {
    return `@/${targetNoExt.slice(SCAN_ROOT.length + 1)}`
  }
  const relative = path.posix.relative(path.posix.dirname(fromRel), targetNoExt)
  return relative.startsWith('.') ? relative : `./${relative}`
}

function resolvesTo(fromRel, specifier, targetNoExt) {
  if (specifier.startsWith('@/') || specifier.startsWith('@renderer/')) {
    return `${SCAN_ROOT}/${specifier.slice(specifier.indexOf('/') + 1)}` === targetNoExt
  }
  return (
    specifier.startsWith('.') &&
    path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier)) === targetNoExt
  )
}

function existingHookBinding(fn, hookName) {
  if (!ts.isBlock(fn.body)) {
    return null
  }
  for (const statement of fn.body.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue
    }
    for (const decl of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(decl.name) &&
        decl.initializer &&
        ts.isCallExpression(decl.initializer) &&
        calleeName(decl.initializer) === hookName
      ) {
        return decl.name.text
      }
    }
  }
  return null
}

export function pickFreeName(node, candidates, taken = new Set()) {
  return (
    candidates.find((name) => !taken.has(name) && identifierUses(node, name).length === 0) ?? null
  )
}

export class FileRewrite {
  constructor(rel, sf) {
    this.rel = rel
    this.sf = sf
    this.text = sf.text
    this.edits = []
    this.ownerBindings = new Map()
    this.hookImports = new Set()
    this.typeImports = new Set()
    this.valueImports = new Set()
    this.replacedNodes = new Set()
    this.appendedArgs = new Map()
  }

  get changed() {
    return this.edits.length > 0
  }

  edit(start, end, text) {
    this.edits.push({ start, end, text })
  }

  /** The hook-bound name for `fn` in `owner`, adding `const x = useX()` on first use. */
  ownerBinding(owner, fn) {
    const bindings = this.ownerBindings.get(owner) ?? {}
    if (bindings[fn]) {
      return bindings[fn]
    }
    const existing = existingHookBinding(owner, HOOKS[fn])
    const taken = new Set(Object.values(bindings))
    const name = existing ?? pickFreeName(owner, NAME_CANDIDATES[fn], taken)
    if (!name) {
      return null
    }
    bindings[fn] = name
    this.ownerBindings.set(owner, bindings)
    if (!existing) {
      bindings.inserts = [...(bindings.inserts ?? []), `const ${name} = ${HOOKS[fn]}()`]
      this.hookImports.add(HOOKS[fn])
    }
    return name
  }

  /** Local name of an i18n module export, importing it when the file does not yet. */
  i18nLocal(name) {
    for (const [local, imported] of findI18nImports(this.sf).locals) {
      if (imported === name) {
        this.valueImports.add(name)
        return local
      }
    }
    this.valueImports.add(name)
    return name
  }

  replaceNode(node, text) {
    this.replacedNodes.add(node)
    this.edit(node.getStart(this.sf), node.getEnd(), text)
  }

  /** Appends `values` (keyed by parameter index) to a call, padding skipped optionals with undefined. */
  appendArgs(call, values) {
    // A call that already passes these positions was threaded by an earlier run.
    const missing = [...values].filter(([index]) => index >= call.arguments.length)
    if (missing.length === 0) {
      return false
    }
    const entry = this.appendedArgs.get(call) ?? new Map()
    for (const [index, value] of missing) {
      entry.set(index, value)
    }
    this.appendedArgs.set(call, entry)
    return true
  }

  addDepsEntry(deps, name) {
    const present = deps.elements.some(
      (element) => ts.isIdentifier(element) && element.text === name
    )
    const key = `deps:${deps.getEnd()}:${name}`
    if (present || this.edits.some((edit) => edit.key === key)) {
      return
    }
    const last = deps.elements.at(-1)
    const at = last ? last.getEnd() : deps.getStart(this.sf) + 1
    this.edits.push({ key, start: at, end: at, text: last ? `, ${name}` : name })
  }

  /** Appends parameters to a function, parenthesizing a bare arrow parameter. */
  addParams(fn, params) {
    const text = params.join(', ')
    const last = fn.parameters.at(-1)
    if (last) {
      const bareArrowParam =
        ts.isArrowFunction(fn) &&
        !this.text.slice(fn.getStart(this.sf), last.getStart(this.sf)).includes('(')
      if (bareArrowParam) {
        this.edit(last.getStart(this.sf), last.getStart(this.sf), '(')
        this.edit(last.getEnd(), last.getEnd(), `, ${text})`)
      } else {
        this.edit(last.getEnd(), last.getEnd(), `, ${text}`)
      }
      return
    }
    const open = this.text.indexOf(
      '(',
      fn.typeParameters?.end ?? fn.name?.end ?? fn.getStart(this.sf)
    )
    this.edit(open + 1, open + 1, text)
  }

  #flushAppendedArgs() {
    for (const [call, values] of this.appendedArgs) {
      const existing = call.arguments.length
      const maxIndex = Math.max(...values.keys())
      const parts = []
      for (let index = existing; index <= maxIndex; index += 1) {
        parts.push(values.get(index) ?? 'undefined')
      }
      const last = call.arguments.at(-1)
      if (last) {
        this.edit(last.getEnd(), last.getEnd(), `, ${parts.join(', ')}`)
      } else {
        const close = call.getEnd() - 1
        this.edit(close, close, parts.join(', '))
      }
    }
  }

  #flushOwnerInserts() {
    for (const [owner, bindings] of this.ownerBindings) {
      if (!bindings.inserts) {
        continue
      }
      const inserts = bindings.inserts.join('\n')
      if (ts.isBlock(owner.body)) {
        let at = owner.body.getStart(this.sf) + 1
        for (const statement of owner.body.statements) {
          if (ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)) {
            at = statement.getEnd()
            continue
          }
          break
        }
        this.edit(at, at, `\n${inserts}`)
      } else {
        // An expression-bodied arrow gets a block so the hooks run before the returned value.
        const body = owner.body
        this.edit(body.getStart(this.sf), body.getStart(this.sf), `{\n${inserts}\nreturn `)
        this.edit(body.getEnd(), body.getEnd(), '\n}')
      }
    }
  }

  #lineEnd(node) {
    return node.getEnd() + (this.text[node.getEnd()] === '\n' ? 1 : 0)
  }

  #flushImports() {
    const sf = this.sf
    const { locals, declarations } = findI18nImports(sf)
    const removeLocals = new Set()
    for (const [local, imported] of locals) {
      if (this.valueImports.has(imported)) {
        continue
      }
      const remaining = identifierUses(sf, local).filter((identifier) => {
        const parent = identifier.parent
        if (ts.isImportSpecifier(parent)) {
          return false
        }
        if (this.replacedNodes.has(parent) || this.replacedNodes.has(identifier)) {
          return false
        }
        return true
      })
      if (remaining.length === 0) {
        removeLocals.add(local)
      }
    }
    const anchor = declarations[0] ?? sf.statements.findLast(ts.isImportDeclaration) ?? null
    let anchorRemoved = false
    for (const decl of declarations) {
      const bindings = decl.importClause?.namedBindings
      if (!bindings || !ts.isNamedImports(bindings)) {
        continue
      }
      const kept = bindings.elements.filter((element) => !removeLocals.has(element.name.text))
      if (kept.length === bindings.elements.length) {
        continue
      }
      if (kept.length === 0 && !decl.importClause.name) {
        if (decl === anchor) {
          anchorRemoved = true
        } else {
          this.edit(decl.getStart(sf), this.#lineEnd(decl), '')
        }
      } else {
        const names = kept.map((element) => element.getText(sf)).join(', ')
        this.edit(bindings.getStart(sf), bindings.getEnd(), `{ ${names} }`)
      }
    }
    const lines = []
    const hookSpecifier = moduleSpecifier(this.rel, HOOK_MODULE, sf)
    const hookNames = [...this.hookImports, ...[...this.typeImports].map((name) => `type ${name}`)]
    if (hookNames.length > 0) {
      const hookImports = sf.statements.filter(
        (statement) =>
          ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          resolvesTo(this.rel, statement.moduleSpecifier.text, HOOK_MODULE) &&
          statement.importClause?.namedBindings &&
          ts.isNamedImports(statement.importClause.namedBindings)
      )
      const present = new Set(
        hookImports.flatMap((statement) =>
          statement.importClause.namedBindings.elements.map((element) => element.name.text)
        )
      )
      const values = [...this.hookImports].filter((name) => !present.has(name))
      const types = [...this.typeImports].filter((name) => !present.has(name))
      const valueImport = hookImports.find((statement) => !statement.importClause.isTypeOnly)
      const typeImport = hookImports.find((statement) => statement.importClause.isTypeOnly)
      const mergeInto = (statement, names) => {
        const bindings = statement.importClause.namedBindings
        const merged = [...bindings.elements.map((element) => element.getText(sf)), ...names]
        this.edit(bindings.getStart(sf), bindings.getEnd(), `{ ${merged.join(', ')} }`)
      }
      if (values.length > 0 || types.length > 0) {
        if (valueImport) {
          mergeInto(valueImport, [...values, ...types.map((name) => `type ${name}`)])
        } else if (values.length === 0 && typeImport) {
          mergeInto(typeImport, types)
        } else if (values.length === 0) {
          lines.push(`import type { ${types.sort().join(', ')} } from '${hookSpecifier}'`)
        } else if (typeImport) {
          // Keep the type-only import; add the hooks beside it.
          lines.push(`import { ${values.sort().join(', ')} } from '${hookSpecifier}'`)
          if (types.length > 0) {
            mergeInto(typeImport, types)
          }
        } else {
          const names = [...values.sort(), ...types.sort().map((name) => `type ${name}`)]
          lines.push(`import { ${names.join(', ')} } from '${hookSpecifier}'`)
        }
      }
    }
    const imported = new Set(locals.values())
    const missingValues = [...this.valueImports].filter((name) => !imported.has(name))
    if (missingValues.length > 0) {
      lines.push(
        `import { ${missingValues.sort().join(', ')} } from '${moduleSpecifier(this.rel, `${SCAN_ROOT}/i18n/i18n`, sf)}'`
      )
    }
    if (lines.length === 0) {
      if (anchorRemoved) {
        this.edit(anchor.getStart(sf), this.#lineEnd(anchor), '')
      }
      return
    }
    if (!anchor) {
      this.edit(0, 0, `${lines.join('\n')}\n`)
    } else if (anchorRemoved) {
      this.edit(anchor.getStart(sf), anchor.getEnd(), lines.join('\n'))
    } else {
      this.edit(anchor.getEnd(), anchor.getEnd(), `\n${lines.join('\n')}`)
    }
  }

  finish() {
    if (!this.changed && this.appendedArgs.size === 0) {
      return this.text
    }
    this.#flushAppendedArgs()
    this.#flushOwnerInserts()
    this.#flushImports()
    const sorted = [...this.edits].sort((a, b) => b.start - a.start || b.end - a.end)
    let output = this.text
    let lastStart = Infinity
    for (const edit of sorted) {
      if (edit.end > lastStart) {
        throw new Error(`${this.rel}: overlapping edits at ${edit.start}`)
      }
      output = output.slice(0, edit.start) + edit.text + output.slice(edit.end)
      lastStart = edit.start
    }
    return output
  }
}
