import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript-api'
import { readTrackedSources } from '../ratchet-baseline/ratchet-baseline.mjs'

import {
  APPLICATION_PUBLICATION_ROOTS,
  DEFERRED_APPLICATION_PUBLICATIONS
} from './application-ipc-publication-policy.mjs'

const NATIVE_CHANNELS = 'config/application-ipc-native-channels.json'
const TRANSPORT_FAMILIES = /^src\/main\/ipc\/(?:pty|ssh|runtime-environments)\//
const ADAPTER = 'src/main/ipc/app-registry/electron-app-ipc.ts'
const REGISTRATION_METHODS = new Set(['handle', 'handleOnce', 'on', 'once'])

export function collectNativeRegistrations(root = process.cwd()) {
  const sources = readTrackedSources(
    root,
    ['src/main/ipc', 'src/main/startup'],
    (file) =>
      file.endsWith('.ts') &&
      !file.includes('.test.') &&
      !file.includes('-test-') &&
      !file.includes('/testing/') &&
      !TRANSPORT_FAMILIES.test(file) &&
      file !== ADAPTER &&
      (file.startsWith('src/main/ipc/') ||
        file === 'src/main/startup/main-process-ipc-bootstrap.ts')
  )
  const registrations = new Map()
  for (const [file, source] of sources) {
    if (!source.includes('electron')) {
      continue
    }
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const receivers = new Set()
    for (const statement of tree.statements) {
      if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== 'electron') {
        continue
      }
      const bindings = statement.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === 'ipcMain') {
            receivers.add(element.name.text)
          }
        }
      }
    }
    const channels = []
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        receivers.has(node.expression.expression.getText(tree)) &&
        REGISTRATION_METHODS.has(node.expression.name.text)
      ) {
        const argument = node.arguments[0]
        channels.push(ts.isStringLiteral(argument) ? argument.text : argument.getText(tree))
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
    if (channels.length) {
      registrations.set(file, [...new Set(channels)].sort())
    }
  }
  return registrations
}

export function main(root = process.cwd()) {
  const allowed = JSON.parse(readFileSync(path.join(root, NATIVE_CHANNELS), 'utf8'))
  const violations = []
  for (const [file, channels] of collectNativeRegistrations(root)) {
    for (const channel of channels) {
      if (!allowed[file]?.includes(channel)) {
        violations.push(`${file}: ${channel}`)
      }
    }
  }
  for (const file of APPLICATION_PUBLICATION_ROOTS) {
    const source = readFileSync(path.join(root, file), 'utf8')
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'send' &&
        node.expression.expression.getText(tree).endsWith('.webContents')
      ) {
        const argument = node.arguments[0]
        const channel = ts.isStringLiteral(argument) ? argument.text : argument.getText(tree)
        if (!DEFERRED_APPLICATION_PUBLICATIONS.get(file)?.includes(channel)) {
          violations.push(`${file}: direct application publication ${channel}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  if (violations.length) {
    console.error(
      `[application-ipc-ratchet] Direct application IPC registrations must use registerAppHandler/registerAppListener:\n${violations.join('\n')}`
    )
    return 1
  }
  console.log(
    '[application-ipc-ratchet] Application ipcMain registrations: 0; native allowlist preserved (transport families are checked by their owner).'
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
