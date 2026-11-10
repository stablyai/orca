// The user path into a cloud workspace: the shipped `orca` CLI over the sandbox's pairing code
// (E2EE to orcad in the VM, the same protocol the desktop uses). The pairing code is never logged.
import { execFile } from 'node:child_process'
import { config } from './env'

export type CliResult = { ok: boolean; ms: number; json: any; stderr: string }

export function orca(pairingCode: string, args: string[], timeoutMs = 60_000): Promise<CliResult> {
  const started = performance.now()
  return new Promise((resolve) => {
    execFile(
      config.orcaCli,
      [...args, '--json', '--pairing-code', pairingCode],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ORCA_PAIRING_CODE: '' } },
      (error, stdout, stderr) => {
        let json: any = null
        try {
          json = JSON.parse(stdout)
        } catch {
          json = null
        }
        resolve({
          ok: !error && json?.ok !== false,
          ms: Math.round(performance.now() - started),
          json,
          stderr: String(stderr).replaceAll(pairingCode, '<pairing>').slice(0, 2000)
        })
      }
    )
  })
}

/** Registers the project root and opens a terminal there; returns the terminal handle. */
export async function openTerminal(pairingCode: string, projectRoot: string, kind: 'git' | 'folder' = 'git') {
  let repo = await orca(pairingCode, ['repo', 'add', '--path', projectRoot, '--kind', kind])
  if (!repo.ok && kind === 'git') {
    repo = await orca(pairingCode, ['repo', 'add', '--path', projectRoot, '--kind', 'folder'])
  }
  const term = await orca(pairingCode, ['terminal', 'create', '--worktree', `path:${projectRoot}`, '--title', 'eval'])
  const handle: string | undefined =
    term.json?.result?.terminal?.handle ?? term.json?.result?.handle ?? term.json?.result?.terminal?.id
  return { repo, term, handle }
}

/** Sends a line and waits until `marker` shows up in the terminal output. Returns ms send->seen. */
export async function typeAndSee(pairingCode: string, handle: string, line: string, marker: string, timeoutMs = 30_000) {
  const started = performance.now()
  const sent = await orca(pairingCode, ['terminal', 'send', '--terminal', handle, '--text', line, '--enter'])
  if (!sent.ok) {
    return { ok: false, ms: Math.round(performance.now() - started), output: '', error: sent.stderr || JSON.stringify(sent.json?.error ?? null) }
  }
  while (performance.now() - started < timeoutMs) {
    const read = await orca(pairingCode, ['terminal', 'read', '--terminal', handle])
    const text = JSON.stringify(read.json?.result ?? '')
    if (text.includes(marker)) {
      return { ok: true, ms: Math.round(performance.now() - started), output: text.slice(-1500), error: '' }
    }
  }
  return { ok: false, ms: Math.round(performance.now() - started), output: '', error: 'marker not seen' }
}
