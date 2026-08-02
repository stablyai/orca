import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = path.resolve(import.meta.dirname, '../..')
const smokeScript = path.join(projectDir, 'config', 'scripts', 'computer-use-smoke.mjs')

describe('computer-use smoke script', () => {
  it('can launch a runtime before checking apps', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-computer-smoke-test-'))
    const cliPath = path.join(root, 'fake-cli.cjs')
    const callsPath = path.join(root, 'calls.jsonl')
    writeFileSync(
      cliPath,
      [
        'const fs = require("node:fs");',
        `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
        'const args = process.argv.slice(2);',
        'if (args[0] === "open") {',
        '  console.log(JSON.stringify({ result: { runtime: { state: "ready", runtimeId: "runtime-test" } } }));',
        '} else if (args.join(" ") === "computer list-apps --json") {',
        '  console.log(JSON.stringify({ result: { apps: [] } }));',
        '} else {',
        '  console.error("unexpected args: " + args.join(" "));',
        '  process.exit(1);',
        '}'
      ].join('\n'),
      'utf8'
    )
    chmodSync(cliPath, 0o755)

    const output = execFileSync(process.execPath, [smokeScript, '--launch'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ORCA_COMPUTER_SMOKE_CLI_PATH: cliPath,
        ORCA_COMPUTER_SMOKE_USER_DATA_PATH: path.join(root, 'user-data')
      }
    })

    expect(output).toContain('computer-use smoke: runtime ready (runtime-test)')
    expect(
      readFileSync(callsPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    ).toEqual([
      ['open', '--json'],
      ['computer', 'list-apps', '--json']
    ])
  })

  it('fails closed when a target app is required but none are available', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-computer-smoke-test-'))
    const cliPath = writeFakeListAppsCli(root, [])

    const result = spawnSync(process.execPath, [smokeScript, '--require-target'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ORCA_COMPUTER_SMOKE_CLI_PATH: cliPath,
        ORCA_COMPUTER_SMOKE_USER_DATA_PATH: path.join(root, 'user-data'),
        ORCA_COMPUTER_SMOKE_APPS: 'TestApp'
      }
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('computer-use smoke: no preferred apps are running (TestApp)')
  })

  it('keeps no-target smoke permissive by default for local probing', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-computer-smoke-test-'))
    const cliPath = writeFakeListAppsCli(root, [])

    const result = spawnSync(process.execPath, [smokeScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ORCA_COMPUTER_SMOKE_CLI_PATH: cliPath,
        ORCA_COMPUTER_SMOKE_USER_DATA_PATH: path.join(root, 'user-data'),
        ORCA_COMPUTER_SMOKE_APPS: 'TestApp'
      }
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('computer-use smoke: no preferred apps are running (TestApp)')
  })

  it('skips background apps that report window_not_found instead of failing smoke', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-computer-smoke-test-'))
    const cliPath = writeFakeSnapshotCli(
      root,
      [
        { name: 'Edge', bundleId: 'com.microsoft.edgemac' },
        { name: 'Notepad', bundleId: null }
      ],
      {
        windowNotFoundApps: ['Edge']
      }
    )

    const result = spawnSync(process.execPath, [smokeScript, '--require-target'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ORCA_COMPUTER_SMOKE_CLI_PATH: cliPath,
        ORCA_COMPUTER_SMOKE_USER_DATA_PATH: path.join(root, 'user-data'),
        ORCA_COMPUTER_SMOKE_APPS: 'Edge,Notepad'
      }
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('computer-use smoke: Edge: skipped')
    expect(result.stdout).toContain('computer-use smoke: Notepad')
  })

  it('uses cross-platform default app targets for smoke snapshots', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-computer-smoke-test-'))
    const cliPath = writeFakeSnapshotCli(root, [{ name: 'Notepad', bundleId: null }])

    const result = spawnSync(process.execPath, [smokeScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ORCA_COMPUTER_SMOKE_CLI_PATH: cliPath,
        ORCA_COMPUTER_SMOKE_USER_DATA_PATH: path.join(root, 'user-data')
      }
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('computer-use smoke: Notepad')
  })
})

function writeFakeListAppsCli(root, apps) {
  const cliPath = path.join(root, 'fake-cli.cjs')
  writeFileSync(
    cliPath,
    [
      'const args = process.argv.slice(2);',
      'if (args.join(" ") === "computer list-apps --json") {',
      `  console.log(JSON.stringify({ result: { apps: ${JSON.stringify(apps)} } }));`,
      '} else {',
      '  console.error("unexpected args: " + args.join(" "));',
      '  process.exit(1);',
      '}'
    ].join('\n'),
    'utf8'
  )
  chmodSync(cliPath, 0o755)
  return cliPath
}

function writeFakeSnapshotCli(root, apps, options = {}) {
  const cliPath = path.join(root, 'fake-cli.cjs')
  writeFileSync(
    cliPath,
    [
      'const args = process.argv.slice(2);',
      `const windowNotFoundApps = new Set(${JSON.stringify(options.windowNotFoundApps ?? [])});`,
      'if (args.join(" ") === "computer list-apps --json") {',
      `  console.log(JSON.stringify({ result: { apps: ${JSON.stringify(apps)} } }));`,
      '} else if (args[0] === "computer" && args[1] === "get-app-state") {',
      '  const appIndex = args.indexOf("--app");',
      '  const app = appIndex >= 0 ? args[appIndex + 1] : "Unknown";',
      '  if (windowNotFoundApps.has(app)) {',
      '    console.log(JSON.stringify({ ok: false, error: { code: "window_not_found", message: `app \'${app}\' has no on-screen window` } }));',
      '    process.exit(1);',
      '  }',
      '  console.log(JSON.stringify({ result: {',
      '    snapshot: {',
      '      app: { name: app },',
      '      elementCount: 1,',
      '      treeText: "[1] text area settable",',
      '      window: { title: "Untitled" }',
      '    },',
      '    screenshot: null',
      '  } }));',
      '} else {',
      '  console.error("unexpected args: " + args.join(" "));',
      '  process.exit(1);',
      '}'
    ].join('\n'),
    'utf8'
  )
  chmodSync(cliPath, 0o755)
  return cliPath
}
