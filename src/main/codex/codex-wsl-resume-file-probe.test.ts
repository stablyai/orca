import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import {
  CODEX_WSL_RESUME_FILE_PROBE,
  probeCodexWslResumeFiles
} from './codex-wsl-resume-file-probe'
import { runCapturedCodexWslProcess } from '../codex-accounts/captured-wsl-account-process'
vi.mock('../codex-accounts/captured-wsl-account-process', () => ({
  runCapturedCodexWslProcess: vi.fn()
}))
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
const id = '11111111-2222-3333-4444-555555555555'
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-resume-owner-')))
  roots.push(root)
  const home = join(root, 'account'),
    date = join(home, 'sessions', '2026', '09', '27')
  mkdirSync(date, { recursive: true })
  const file = join(date, `rollout-date-${id}.jsonl`)
  writeFileSync(file, '{}\n')
  return { root, home, file, date }
}
async function probe(home: string, transcript: string, prefix = '') {
  const statShim =
    process.platform === 'darwin' ? 'stat() { /usr/bin/stat -f %u "${@: -1}"; }\n' : ''
  return runProcess({
    program: 'bash',
    args: ['-c', statShim + prefix + CODEX_WSL_RESUME_FILE_PROBE, 'probe', id, transcript, home],
    timeoutMs: 5000,
    maxOutputBytes: 65536
  })
}
it.skipIf(process.platform === 'win32')(
  'executes guest verification for provenance and legacy scans without reading rollout contents',
  async () => {
    const { home, file } = fixture()
    for (const path of [file, '']) {
      const result = await probe(home, path)
      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`${file}\0ORCA_CODEX_RESUME_PROBE_COMPLETE\0`)
    }
  }
)
it.skipIf(process.platform === 'win32')(
  'rejects symlink provenance and a symlink account home',
  async () => {
    const { root, home, file, date } = fixture()
    const alias = join(date, `rollout-alias-${id}.jsonl`)
    symlinkSync(file, alias)
    expect((await probe(home, alias)).stdout).toBe('ORCA_CODEX_RESUME_PROBE_COMPLETE\0')
    const linkedHome = join(root, 'linked')
    symlinkSync(home, linkedHome)
    expect((await probe(linkedHome, '')).code).toBe(80)
  }
)
it.skipIf(process.platform === 'win32')(
  'rejects a file whose owner differs from the captured user',
  async () => {
    const { home, file } = fixture()
    const result = await probe(
      home,
      file,
      `stat() { if [ "\${@: -1}" = '${file}' ]; then echo 999999; else id -u; fi; }\n`
    )
    expect(result.stdout).toBe('ORCA_CODEX_RESUME_PROBE_COMPLETE\0')
  }
)
it('treats truncated guest output as failure rather than another-account fallback', async () => {
  vi.mocked(runCapturedCodexWslProcess).mockResolvedValue({
    code: 0,
    stdout: 'partial',
    stderr: '',
    timedOut: false,
    environmentResolved: true
  })
  const execution = { distro: 'Ubuntu', userName: 'alice', userId: '1000', home: '/home/alice' }
  await expect(
    probeCodexWslResumeFiles({
      execution,
      homes: ['/home/alice/.codex'],
      sessionId: id,
      transcriptPath: ''
    })
  ).rejects.toThrow('could not be verified')
  expect(runCapturedCodexWslProcess).toHaveBeenCalledWith(
    expect.objectContaining({ distro: 'Ubuntu', shell: 'bash', loginPath: 'none' }),
    execution
  )
})
