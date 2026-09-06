import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { runProcess } from '../shared/child-process/run-process'

let directory: string
let bundle: string
let fixtureEnv: NodeJS.ProcessEnv
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca standalone bridge '))
  bundle = join(directory, 'chrome-devtools.cjs')
  const build = await runProcess({
    program: process.execPath,
    args: [resolve('config/scripts/build-chrome-devtools-standalone.mjs'), bundle],
    timeoutMs: 30_000
  })
  expect(build.code, build.stderr).toBe(0)
  const server = join(directory, 'fake-mcp.mjs')
  await writeFile(
    server,
    `
import { createInterface } from 'node:readline'
let snapshot = false
const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  let result
  if (request.method === 'initialize') {
    result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
  } else if (request.method === 'tools/list') {
    result = { tools: [{ name: 'list_pages', inputSchema: { type: 'object', properties: { pageId: { type: 'integer' } } } }] }
  } else if (request.method === 'tools/call') {
    if (request.params.name === 'take_snapshot') snapshot = true
    const failed = request.params.name === 'fail' || (request.params.name === 'use_snapshot' && !snapshot)
    result = { isError: failed, content: [{ type: 'text', text: JSON.stringify({ tool: request.params.name, args: request.params.arguments, snapshot }) }] }
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
})
`
  )
  const launcher = join(directory, process.platform === 'win32' ? 'npx.cmd' : 'npx')
  await writeFile(
    launcher,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${server}" %*\r\n`
      : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(server)} "$@"\n`
  )
  await chmod(launcher, 0o755)
  fixtureEnv = {
    ...process.env,
    PATH: [directory, dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
    ORCA_CLI_CWD: '',
    ORCA_ENVIRONMENT: '',
    ORCA_PAIRING_CODE: ''
  }
}, 30_000)

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

function execute(args: string[], input?: string, env = fixtureEnv) {
  return runProcess({
    program: process.execPath,
    args: [bundle, ...args],
    cwd: directory,
    env,
    input,
    timeoutMs: 15_000
  })
}

describe('standalone Chrome DevTools distribution outside the repository', () => {
  it('contains bundled dependencies and prints only standalone help', async () => {
    const source = await readFile(bundle, 'utf8')
    expect(source).not.toContain('requireOutMainModule')
    expect(source).not.toContain('require("electron")')
    const result = await execute(['--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('orca-chrome-devtools <command>')
    expect(result.stdout).not.toContain('orca chrome-devtools')
    for (const command of ['tools', 'call', 'session']) {
      const help = await execute([command, '--help'])
      expect(help.code).toBe(0)
      expect(help.stdout).toContain(`orca-chrome-devtools ${command}`)
    }
  })

  it('retains full schemas and JSON file arguments without repository runtime files', async () => {
    const discovered = await execute(['tools', '--json'])
    expect(discovered.code, discovered.stderr).toBe(0)
    expect(JSON.parse(discovered.stdout).result.tools[0].inputSchema.properties.pageId.type).toBe(
      'integer'
    )
    const args = { text: 'spaces "quotes" $(literal)', pageId: 1 }
    await writeFile(join(directory, 'arguments.json'), JSON.stringify(args))
    const called = await execute([
      'call',
      '--tool',
      'list_pages',
      '--arguments-file',
      'arguments.json',
      '--json'
    ])
    expect(called.code, called.stderr).toBe(0)
    expect(JSON.parse(JSON.parse(called.stdout).result.content[0].text).args).toEqual(args)
  })

  it('preserves session state and buffered piped input until EOF', async () => {
    const requests = [
      { id: 'snapshot', type: 'call', tool: 'take_snapshot' },
      { id: 'use', type: 'call', tool: 'use_snapshot' }
    ]
      .map((request) => JSON.stringify(request))
      .join('\n')
    const session = await execute(['session'], `${requests}\n`)
    expect(session.code, session.stderr).toBe(0)
    const responses = session.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(responses.map((response) => [response.id, response.ok])).toEqual([
      ['snapshot', true],
      ['use', true]
    ])
    expect(JSON.parse(responses[1].result.content[0].text).snapshot).toBe(true)
  })

  it('retains argument, remote-boundary, and tool error exit behavior', async () => {
    const invalid = await execute(['call', '--json'])
    expect(invalid.code).toBe(1)
    expect(invalid.stdout).toContain('Provide --tool')
    const remote = await execute(['tools', '--json'], undefined, {
      ...fixtureEnv,
      ORCA_ENVIRONMENT: 'remote'
    })
    expect(remote.code).toBe(1)
    expect(remote.stdout).toContain('direct local invocation')
    const failed = await execute(['call', '--tool', 'fail', '--json'])
    expect(failed.code).toBe(1)
    expect(JSON.parse(failed.stdout).result.isError).toBe(true)
  })
})
