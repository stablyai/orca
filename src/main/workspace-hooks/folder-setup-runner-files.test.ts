import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newFolderSetupRunnerPath, removeFolderSetupRunnerFiles } from './folder-setup-runner-files'

const WORKSPACE_A = 'repo::/acme::workspace:11111111-1111-4111-8111-111111111111'
const WORKSPACE_B = 'repo::/acme::workspace:22222222-2222-4222-8222-222222222222'

let folder: string

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'orca-folder-runner-'))
})

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

function writeRunner(worktreeId: string): string {
  const path = newFolderSetupRunnerPath(folder, worktreeId, 'sh')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'echo setup\n')
  return path
}

describe('folder setup runner files', () => {
  it("removes only the removed workspace's runners", async () => {
    writeRunner(WORKSPACE_A)
    writeRunner(WORKSPACE_A)
    const kept = writeRunner(WORKSPACE_B)
    writeFileSync(join(folder, '.orca', 'issue-command'), 'claude')
    await removeFolderSetupRunnerFiles(folder, WORKSPACE_A)
    expect(readdirSync(join(folder, '.orca')).sort()).toEqual(
      ['issue-command', dirname(kept).split(/[\\/]/).pop()!].sort()
    )
    expect(readdirSync(dirname(kept))).toEqual([kept.split(/[\\/]/).pop()!])
  })
})
