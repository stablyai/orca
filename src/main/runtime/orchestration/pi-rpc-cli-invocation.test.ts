import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveTrustedPiRpcCliInvocation } from './pi-rpc-cli-invocation'

const cleanup: string[] = []
const runRealMacFixture =
  process.env.ORCA_RUN_REAL_PI_RPC_FIXTURE === '1' && process.platform === 'darwin' ? it : it.skip

async function fixture() {
  const root = await mkdtemp(join(process.cwd(), '.pi-rpc-cli-test-'))
  cleanup.push(root)
  const workspace = join(root, 'workspace')
  const trusted = join(root, 'trusted')
  await mkdir(workspace)
  await mkdir(trusted)
  const executable = join(trusted, process.platform === 'win32' ? 'Orca.exe' : 'Orca')
  const cliEntry = join(trusted, 'index.js')
  await writeFile(executable, process.platform === 'win32' ? 'fixture' : '#!/bin/sh\nexit 0\n')
  await writeFile(cliEntry, 'console.log("fixture")\n')
  if (process.platform !== 'win32') {
    await chmod(executable, 0o755)
  }
  return { workspace, trusted, executable, cliEntry }
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('trusted Pi RPC CLI invocation', () => {
  it('returns canonical native runtime and CLI entry paths with fixed environment', async () => {
    const { workspace, executable, cliEntry } = await fixture()
    expect(
      resolveTrustedPiRpcCliInvocation({
        executablePath: executable,
        cliEntryPath: cliEntry,
        workspacePath: workspace
      })
    ).toEqual({
      executable,
      argsPrefix: [cliEntry],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
  })

  it('rejects executable or CLI entry paths inside the worker workspace', async () => {
    const { workspace, executable, cliEntry } = await fixture()
    const workspaceExecutable = join(workspace, process.platform === 'win32' ? 'Orca.exe' : 'Orca')
    await writeFile(workspaceExecutable, process.platform === 'win32' ? 'fixture' : '#!/bin/sh\n')
    if (process.platform !== 'win32') {
      await chmod(workspaceExecutable, 0o755)
    }
    expect(() =>
      resolveTrustedPiRpcCliInvocation({
        executablePath: workspaceExecutable,
        cliEntryPath: cliEntry,
        workspacePath: workspace
      })
    ).toThrow('untrusted')
    expect(() =>
      resolveTrustedPiRpcCliInvocation({
        executablePath: executable,
        cliEntryPath: join(workspace, 'index.js'),
        workspacePath: workspace
      })
    ).toThrow()
  })

  it.runIf(process.platform !== 'win32')('rejects writable invocation files', async () => {
    const { workspace, executable, cliEntry } = await fixture()
    await chmod(cliEntry, 0o666)
    expect(() =>
      resolveTrustedPiRpcCliInvocation({
        executablePath: executable,
        cliEntryPath: cliEntry,
        workspacePath: workspace
      })
    ).toThrow('untrusted')
  })

  runRealMacFixture('validates the installed signed Orca runtime and unpacked CLI entry', () => {
    expect(
      resolveTrustedPiRpcCliInvocation({
        executablePath: '/Applications/Orca.app/Contents/MacOS/Orca',
        cliEntryPath:
          '/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/cli/index.js',
        workspacePath: process.cwd()
      })
    ).toEqual({
      executable: '/Applications/Orca.app/Contents/MacOS/Orca',
      argsPrefix: ['/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/cli/index.js'],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
  })
})
