import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript-api'

export const TEXT_INPUT_FONT_SIZE_SEAM = 'src/platform/text-input/text-input-font-size.web.ts'

const FLOOR_EXPORT = 'TEXT_INPUT_FONT_SIZE_FLOOR'

const parse = (file, source) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)

const floorByRoot = new Map()

// Read seam’s floor rather than copy 16 beside max(bodySize,floor); missing declaration throws so moved/deleted seam cannot silently pass.
export function textInputFontSizeFloor(mobileDir) {
  const cached = floorByRoot.get(mobileDir)
  if (cached !== undefined) {
    return cached
  }
  const source = readOrNull(join(mobileDir, TEXT_INPUT_FONT_SIZE_SEAM))
  if (source === null) {
    throw new Error(`[text-input-font-size-seam] no seam at ${TEXT_INPUT_FONT_SIZE_SEAM}`)
  }
  const parsed = parse(TEXT_INPUT_FONT_SIZE_SEAM, source)
  const declared = declarationOf(parsed, FLOOR_EXPORT)
  if (declared === null || !ts.isNumericLiteral(declared)) {
    throw new Error(
      `[text-input-font-size-seam] ${TEXT_INPUT_FONT_SIZE_SEAM} declares no numeric ${FLOOR_EXPORT}`
    )
  }
  const floor = Number(declared.text)
  floorByRoot.set(mobileDir, floor)
  return floor
}

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function declarationOf(parsed, name) {
  let found = null
  const visit = (node) => {
    if (
      found === null &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = node.initializer ?? null
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(parsed, visit)
  return found
}

// Derive actual TextInput modules by JSX tags, not mentions; exported census checks handwritten closure completeness.
export function modulesDeclaringTextInput(mobileDir, directory) {
  const found = []
  const walk = (relativeDirectory) => {
    const absolute = join(mobileDir, relativeDirectory)
    if (!existsSync(absolute)) {
      return
    }
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = `${relativeDirectory}/${entry.name}`
      if (entry.isDirectory()) {
        walk(child)
        continue
      }
      if (!/\.(tsx|ts)$/.test(entry.name) || /\.test\.(tsx|ts)$/.test(entry.name)) {
        continue
      }
      const source = readOrNull(join(mobileDir, child))
      if (source !== null && declaresTextInput(parse(child, source))) {
        found.push(child)
      }
    }
  }
  walk(directory)
  return found.sort()
}

function declaresTextInput(parsed) {
  let found = false
  const visit = (node) => {
    if (found) {
      return
    }
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText() === 'TextInput'
    ) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(parsed, visit)
  return found
}
