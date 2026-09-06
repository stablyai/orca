// Runs on every platform: parity against real git is the Windows-relevant half of
// the admission evidence, so it must not share the storm harness's POSIX gate.
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { gitExecFileAsync, gitExecFileAsyncBuffer } from './git-exec-file'
import { _resetGitAdmissionForTests } from './git-subprocess-admission'

const tempRoots: string[] = []
const originalAdmissionDisabled = process.env.ORCA_GIT_ADMISSION_DISABLED

afterEach(async () => {
  if (originalAdmissionDisabled === undefined) {
    delete process.env.ORCA_GIT_ADMISSION_DISABLED
  } else {
    process.env.ORCA_GIT_ADMISSION_DISABLED = originalAdmissionDisabled
  }
  _resetGitAdmissionForTests()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function setAdmissionDisabled(disabled: boolean): void {
  if (disabled) {
    process.env.ORCA_GIT_ADMISSION_DISABLED = '1'
  } else {
    delete process.env.ORCA_GIT_ADMISSION_DISABLED
  }
}

it('keeps real git output byte-identical with admission on and bypassed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-git-output-parity-'))
  tempRoots.push(root)
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Orca Test'], { cwd: root })
  await writeFile(path.join(root, 'tracked.txt'), 'line one\nline two\n')
  await writeFile(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3, 255]))
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: root })
  await writeFile(path.join(root, 'tracked.txt'), 'line one\nchanged\n')

  const runBattery = async (disabled: boolean): Promise<(string | Buffer)[]> => {
    setAdmissionDisabled(disabled)
    return [
      (await gitExecFileAsync(['status', '--porcelain=v2'], { cwd: root })).stdout,
      (await gitExecFileAsync(['diff', '--numstat'], { cwd: root })).stdout,
      (await gitExecFileAsync(['branch', '-a'], { cwd: root })).stdout,
      (await gitExecFileAsync(['rev-parse', 'HEAD'], { cwd: root })).stdout,
      (await gitExecFileAsyncBuffer(['show', 'HEAD:blob.bin'], { cwd: root })).stdout
    ]
  }

  const enabled = await runBattery(false)
  const bypassed = await runBattery(true)
  expect(bypassed).toEqual(enabled)
  expect(await readFile(path.join(root, 'blob.bin'))).toEqual(enabled.at(-1))
  console.info('GIT_ADMISSION_OUTPUT_PARITY=byte-identical')
})
