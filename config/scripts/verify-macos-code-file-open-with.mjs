import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { build, Platform } from 'electron-builder'

assert.equal(process.platform, 'darwin', 'Run this check on macOS.')
const require = createRequire(import.meta.url)
const config = require('../electron-builder.config.cjs')
const electronPackage = require.resolve('electron/package.json')
// LaunchServices does not advertise apps registered under the system temporary directory.
const root = await mkdtemp(join(homedir(), 'Library', 'Caches', 'orca-file-associations-'))
const bundleId = `dev.orca.file-associations.${randomUUID()}`
const productName = 'Orca File Association Check'
const bundle = join(
  root,
  'dist',
  process.arch === 'arm64' ? 'mac-arm64' : 'mac',
  `${productName}.app`
)
const lsregister =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
let registered = false

try {
  const app = join(root, 'app')
  await mkdir(app)
  await writeFile(
    join(app, 'package.json'),
    JSON.stringify({ name: 'orca-file-associations-check', version: '0.0.0', main: 'main.cjs' })
  )
  await writeFile(join(app, 'main.cjs'), "require('electron').app.quit()\n")
  const filenames = [
    'package.json',
    'source.ts',
    'script.py',
    'config.yaml',
    'notes.txt',
    'view.vue',
    'readme.md',
    'data.csv',
    'data.tsv'
  ]
  const files = filenames.map((filename) => join(root, filename))
  for (const file of files) {
    await writeFile(file, '{}\n')
  }
  const probe = join(root, 'applications.swift')
  await writeFile(
    probe,
    `import AppKit
import Foundation
let rows: [[String: Any]] = CommandLine.arguments.dropFirst().map { path in
  let url = URL(fileURLWithPath: path)
  let candidates = NSWorkspace.shared.urlsForApplications(toOpen: url).compactMap { Bundle(url: $0)?.bundleIdentifier }
  let defaultId = NSWorkspace.shared.urlForApplication(toOpen: url).flatMap { Bundle(url: $0)?.bundleIdentifier }
  return ["name": url.lastPathComponent, "candidates": candidates, "default": defaultId as Any? ?? NSNull()]
}
print(String(data: try JSONSerialization.data(withJSONObject: rows), encoding: .utf8)!)
`
  )
  const query = () =>
    JSON.parse(execFileSync('xcrun', ['swift', probe, ...files], { encoding: 'utf8' }))
  const before = query()
  await build({
    projectDir: root,
    targets: Platform.MAC.createTarget('dir'),
    publish: 'never',
    config: {
      appId: bundleId,
      productName,
      electronVersion: JSON.parse(await readFile(electronPackage, 'utf8')).version,
      electronDist: join(dirname(electronPackage), 'dist'),
      directories: { app: 'app', output: 'dist' },
      asar: false,
      npmRebuild: false,
      mac: { fileAssociations: config.mac.fileAssociations, identity: '-', hardenedRuntime: false }
    }
  })
  const plist = JSON.parse(
    execFileSync(
      'plutil',
      ['-convert', 'json', '-o', '-', join(bundle, 'Contents', 'Info.plist')],
      {
        encoding: 'utf8'
      }
    )
  )
  const documentTypes = plist.CFBundleDocumentTypes
  assert.ok(documentTypes.length > 0)
  assert.ok(
    documentTypes.every(
      (type) => type.CFBundleTypeRole === 'Editor' && type.LSHandlerRank === 'Alternate'
    )
  )
  const extensions = documentTypes.flatMap((type) => type.CFBundleTypeExtensions ?? [])
  assert.ok(!extensions.some((extension) => ['*', 'bin', 'png', 'pdf', 'exe'].includes(extension)))
  assert.equal(plist.CFBundleIdentifier, bundleId)
  console.log(execFileSync(lsregister, ['-f', '-v', bundle], { encoding: 'utf8' }).trim())
  registered = true
  const after = query()
  const checks = after.map((row, index) => ({
    name: row.name,
    candidate: row.candidates.includes(bundleId),
    defaultUnchanged: row.default === before[index].default
  }))
  console.log(JSON.stringify({ bundleId, extensionCount: extensions.length, checks }, null, 2))
  assert.ok(
    checks.every((check) => check.candidate),
    'The built app must be a native Open With candidate for every sample.'
  )
  assert.ok(
    checks.every((check) => check.defaultUnchanged),
    'Existing default applications must remain unchanged.'
  )
} finally {
  if (registered) {
    execFileSync(lsregister, ['-u', bundle])
  }
  await rm(root, { recursive: true, force: true })
}
