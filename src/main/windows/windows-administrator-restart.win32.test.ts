import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { quoteWindowsArgument } from '@orca/process-host/windows-command-line'

describe.runIf(process.platform === 'win32')('native Windows administrator restart', () => {
  it('keeps the CLI console-based and the administrator handoff free of console windows', async () => {
    const root = resolve(import.meta.dirname, '../../..')
    for (const [filename, subsystem] of [
      ['orca.exe', 3],
      ['orca-administrator-restart.exe', 2]
    ] as const) {
      const binary = await readFile(join(root, 'native/windows-cli-launcher/.build', filename))
      const peOffset = binary.readUInt32LE(0x3c)
      expect(binary.toString('latin1', peOffset, peOffset + 4)).toBe('PE\0\0')
      expect(binary.readUInt16LE(peOffset + 24 + 68)).toBe(subsystem)
    }
  })
  it('launches an elevated process with intact arguments without a UAC prompt', async (context) => {
    const root = resolve(import.meta.dirname, '../../..')
    const launcher = join(root, 'native', 'windows-cli-launcher', '.build', 'orca.exe')
    const restartLauncher = join(
      root,
      'native/windows-cli-launcher/.build/orca-administrator-restart.exe'
    )
    const status = await runProcess({ program: launcher, args: ['--orca-administrator-status'] })
    expect(status.code).toBe(0)
    // A standard-user test must never display a Windows permission prompt.
    if (status.stdout.trim() !== 'true') {
      context.skip()
      return
    }

    const directory = await mkdtemp(join(tmpdir(), 'orca administrator α '))
    try {
      const output = join(directory, 'proof.json')
      const fixture = join(directory, 'restart fixture.mjs')
      const processHost = pathToFileURL(join(root, 'src/packages/process-host/dist/run-process.js'))
      await writeFile(
        fixture,
        `import { writeFile } from 'node:fs/promises'
import { runProcess } from ${JSON.stringify(processHost.href)}
const result = await runProcess({ program: ${JSON.stringify(launcher)}, args: ['--orca-administrator-status'] })
await writeFile(${JSON.stringify(output)}, JSON.stringify({
  args: process.argv.slice(2), administrator: result.stdout.trim() === 'true', code: result.code,
  background: process.env.ORCA_BACKGROUND_LAUNCH
}))
`
      )
      const argumentsToPreserve = ['value with spaces', 'literal "quote"', '中文', 'trailing\\']
      const restartFlag = '--orca-restart-local-terminals-as-administrator'
      const parameters = [fixture, ...argumentsToPreserve]
      const result = await runProcess({
        program: restartLauncher,
        args: [
          '--orca-restart-as-administrator',
          process.execPath,
          [...parameters, restartFlag].map(quoteWindowsArgument).join(' '),
          parameters.map(quoteWindowsArgument).join(' ')
        ],
        env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
        timeoutMs: 10_000
      })
      expect(result.code).toBe(0)
      expect(result.timedOut).toBe(false)
      await expect
        .poll(async () => JSON.parse(await readFile(output, 'utf8')), { timeout: 10_000 })
        .toEqual({
          args: [...argumentsToPreserve, restartFlag],
          administrator: true,
          code: 0,
          background: '1'
        })
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }, 30_000)
})
