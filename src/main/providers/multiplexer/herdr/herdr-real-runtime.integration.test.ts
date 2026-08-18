import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configHomeDir } from './herdr-stock-binary'
import { afterAll, describe, expect, it } from 'vitest'
import { HerdrCliHostTransport, localHerdrCommand } from './herdr-cli-session'
import type { HerdrHostTransport, HerdrSessionSnapshot } from './herdr-runtime-contract'
import { unwrapHerdrResponse } from './herdr-runtime-contract'
import { resolveStockHerdrTestBinary } from './herdr-stock-binary'
import { terminalLogicalInputFromBytes } from '../../../../shared/terminal-logical-key'

const binary = resolveStockHerdrTestBinary()
const describeRealHerdr = binary ? describe : describe.skip

describeRealHerdr('stock Herdr runtime integration', () => {
  const configHome = configHomeDir()
  const sessionName = `ot-${process.pid}`
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: configHome }
  for (const name of Object.keys(env)) {
    if (name.startsWith('HERDR_')) {
      delete env[name]
    }
  }
  const transport = new HerdrCliHostTransport({
    commandFor: localHerdrCommand(binary as string, env),
    timeoutMs: 30_000
  })

  afterAll(() => {
    try {
      execFileSync(binary as string, ['session', 'stop', sessionName, '--json'], {
        env,
        stdio: 'ignore',
        timeout: 30_000
      })
    } catch {
      // Session never started (early failure); cleanup must not mask the original cause.
    } finally {
      rmSync(configHome, { recursive: true, force: true })
    }
  })

  it('starts a named server and reconciles through stock metadata commands', async () => {
    await transport.ensureSession(sessionName)
    const created = unwrapHerdrResponse<{
      workspace: { workspace_id: string }
      root_pane: { pane_id: string }
    }>(
      await transport.request(sessionName, 'workspace.create', {
        cwd: configHome,
        label: 'Orca integration',
        focus: false
      })
    )
    await transport.request(sessionName, 'workspace.report_metadata', {
      workspace_id: created.workspace.workspace_id,
      source: 'orca',
      tokens: { orca_binding: 'workspace-binding' }
    })
    await transport.request(sessionName, 'pane.report_metadata', {
      pane_id: created.root_pane.pane_id,
      source: 'orca',
      tokens: { orca_binding: 'pane-binding' }
    })

    const snapshot = unwrapHerdrResponse<{ snapshot: HerdrSessionSnapshot }>(
      await transport.request(sessionName, 'session.snapshot', {})
    ).snapshot
    expect(snapshot.protocol).toBe(19)
    expect(
      snapshot.workspaces.find(
        (workspace) => workspace.workspace_id === created.workspace.workspace_id
      )?.tokens
    ).toMatchObject({ orca_binding: 'workspace-binding' })
    expect(
      snapshot.panes.find((pane) => pane.pane_id === created.root_pane.pane_id)?.tokens
    ).toMatchObject({ orca_binding: 'pane-binding' })
  }, 30_000)

  it('echoes input through pane.send_text and pane.read', async () => {
    await transport.ensureSession(sessionName)
    const created = unwrapHerdrResponse<{
      root_pane: { pane_id: string }
    }>(
      await transport.request(sessionName, 'workspace.create', {
        cwd: configHome,
        label: 'Orca io',
        focus: false
      })
    )
    const marker = `STOCK_IO_${process.pid}`
    unwrapHerdrResponse(
      await transport.request(sessionName, 'pane.send_text', {
        pane_id: created.root_pane.pane_id,
        text: `echo ${marker}`
      })
    )
    unwrapHerdrResponse(
      await transport.request(sessionName, 'pane.send_keys', {
        pane_id: created.root_pane.pane_id,
        keys: ['Enter']
      })
    )

    const deadline = Date.now() + 10_000
    let text = ''
    while (Date.now() < deadline) {
      const read = unwrapHerdrResponse<{ read: { text: string } }>(
        await transport.request(sessionName, 'pane.read', {
          pane_id: created.root_pane.pane_id,
          source: 'recent',
          lines: 80
        })
      )
      text = read.read.text
      if (text.includes(marker)) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(text).toContain(marker)
  }, 30_000)

  it('resizes through the control stream and keeps option-backspace off the echo', async () => {
    await transport.ensureSession(sessionName)
    const created = unwrapHerdrResponse<{
      root_pane: { pane_id: string }
    }>(
      await transport.request(sessionName, 'workspace.create', {
        cwd: configHome,
        label: 'Orca size',
        focus: false
      })
    )
    const controller = transport.controlTerminal(sessionName, created.root_pane.pane_id, {
      cols: 80,
      rows: 24
    })
    controller.resize(120, 40)
    await new Promise((resolve) => setTimeout(resolve, 300))
    unwrapHerdrResponse(
      await transport.request(sessionName, 'pane.send_text', {
        pane_id: created.root_pane.pane_id,
        text: 'printf COLS=%s\\n "$COLUMNS"'
      })
    )
    unwrapHerdrResponse(
      await transport.request(sessionName, 'pane.send_keys', {
        pane_id: created.root_pane.pane_id,
        keys: ['Enter']
      })
    )
    unwrapHerdrResponse(
      await transport.request(sessionName, 'pane.send_text', {
        pane_id: created.root_pane.pane_id,
        text: 'abcd'
      })
    )
    controller.write('\u001b\u007f')

    const deadline = Date.now() + 10_000
    let text = ''
    while (Date.now() < deadline) {
      const read = unwrapHerdrResponse<{ read: { text: string } }>(
        await transport.request(sessionName, 'pane.read', {
          pane_id: created.root_pane.pane_id,
          source: 'recent',
          lines: 80
        })
      )
      text = read.read.text
      if (text.includes('COLS=120') && !text.includes('^[?')) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    controller.release()
    expect(text).toMatch(/COLS=120/)
    expect(text).not.toContain('^[?')
    expect(text).not.toContain('^[\u007f')
  }, 30_000)

  it('interrupts a running command with Ctrl+C through pane.send_keys', async () => {
    await transport.ensureSession(sessionName)
    const paneId = await createPane(transport, sessionName, configHome, 'Orca sigint')
    unwrapHerdrResponse(
      await transport.request(sessionName, 'pane.send_text', {
        pane_id: paneId,
        text: 'sleep 30; echo SLEEP_DONE'
      })
    )
    unwrapHerdrResponse(
      await transport.request(sessionName, 'pane.send_keys', {
        pane_id: paneId,
        keys: ['Enter']
      })
    )
    await waitForPaneText(transport, sessionName, paneId, (text) => text.includes('sleep 30'))
    await writeProductInput(transport, sessionName, paneId, '\x03')

    const text = await waitForPaneText(transport, sessionName, paneId, (value) =>
      value.includes('^C')
    )
    expect(text).toContain('^C')
    expect(text.split('\n').some((line) => line.trim() === 'SLEEP_DONE')).toBe(false)
  }, 30_000)

  it('interrupts a running command through exclusive session-control input', async () => {
    await transport.ensureSession(sessionName)
    const paneId = await createPane(transport, sessionName, configHome, 'Orca sigint stream')
    const controller = transport.controlTerminal(sessionName, paneId, { cols: 80, rows: 24 })
    unwrapHerdrResponse(
      await transport.request(sessionName, 'pane.send_text', {
        pane_id: paneId,
        text: 'sleep 30; echo STREAM_SLEEP_DONE'
      })
    )
    controller.write('\r')
    await waitForPaneText(transport, sessionName, paneId, (text) => text.includes('sleep 30'))
    await writeProductInput(transport, sessionName, paneId, '\x03')

    const text = await waitForPaneText(transport, sessionName, paneId, (value) =>
      value.includes('^C')
    )
    controller.release()
    expect(text).toContain('^C')
    expect(text.split('\n').some((line) => line.trim() === 'STREAM_SLEEP_DONE')).toBe(false)
  }, 30_000)

  it('delivers Esc as a logical key to a raw reader', async () => {
    await transport.ensureSession(sessionName)
    const paneId = await createPane(transport, sessionName, configHome, 'Orca esc')
    const reader = join(configHome, 'read-one.py')
    writeFileSync(
      reader,
      [
        'import sys, tty',
        'tty.setraw(sys.stdin.fileno())',
        'print("READY", flush=True)',
        'b = sys.stdin.buffer.read(1)',
        'print("\\r\\nGOT:" + b.hex(), flush=True)'
      ].join('\n')
    )
    unwrapHerdrResponse(
      await transport.request(sessionName, 'pane.send_text', {
        pane_id: paneId,
        text: `python3 -u ${reader}`
      })
    )
    unwrapHerdrResponse(
      await transport.request(sessionName, 'pane.send_keys', {
        pane_id: paneId,
        keys: ['Enter']
      })
    )
    await waitForPaneText(transport, sessionName, paneId, (text) => text.includes('READY'))
    await writeProductInput(transport, sessionName, paneId, '\x1b')

    const text = await waitForPaneText(transport, sessionName, paneId, (value) =>
      value.includes('GOT:1b')
    )
    expect(text).toContain('GOT:1b')
  }, 30_000)
})

async function createPane(
  transport: HerdrHostTransport,
  sessionName: string,
  cwd: string,
  label: string
): Promise<string> {
  return unwrapHerdrResponse<{ root_pane: { pane_id: string } }>(
    await transport.request(sessionName, 'workspace.create', {
      cwd,
      label,
      focus: false
    })
  ).root_pane.pane_id
}

async function writeProductInput(
  transport: HerdrHostTransport,
  sessionName: string,
  paneId: string,
  data: string
): Promise<void> {
  const input = terminalLogicalInputFromBytes(data)
  if (input.kind !== 'key') {
    throw new Error(`expected a logical Herdr key for ${JSON.stringify(data)}`)
  }
  unwrapHerdrResponse(
    await transport.request(sessionName, 'pane.send_keys', {
      pane_id: paneId,
      keys: [input.name]
    })
  )
}

async function waitForPaneText(
  transport: HerdrHostTransport,
  sessionName: string,
  paneId: string,
  match: (text: string) => boolean
): Promise<string> {
  const deadline = Date.now() + 10_000
  let text = ''
  while (Date.now() < deadline) {
    const read = unwrapHerdrResponse<{ read: { text: string } }>(
      await transport.request(sessionName, 'pane.read', {
        pane_id: paneId,
        source: 'recent',
        lines: 80
      })
    )
    text = read.read.text
    if (match(text)) {
      return text
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return text
}
