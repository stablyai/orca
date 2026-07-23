import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendSshConfigExpandedLine,
  createSshConfigExpansionBudget,
  readSshConfigSourceFile,
  SSH_CONFIG_INCLUDE_LIMITS
} from './ssh-config-expansion-budget'
import { expandSshConfigIncludes } from './ssh-config-include-expander'

const tempRoots: string[] = []

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-ssh-config-bounds-'))
  tempRoots.push(root)
  return root
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('SSH config include expansion bounds', () => {
  it('stops recursive includes at 16 active files', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = makeTempRoot()
    for (let depth = 0; depth < 20; depth += 1) {
      writeFileSync(
        join(root, `${depth}.conf`),
        `Host depth-${depth}\n${depth < 19 ? `Include ${depth + 1}.conf\n` : ''}`
      )
    }

    const expanded = expandSshConfigIncludes(join(root, '0.conf'))

    expect(expanded).toContain('Host depth-15')
    expect(expanded).not.toContain('Host depth-16')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('nesting exceeds 16'))
  })

  it('admits exactly 1,024 unique files and 16 MiB of source bytes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = makeTempRoot()
    const firstPath = join(root, 'first.conf')
    const secondPath = join(root, 'second.conf')
    writeFileSync(firstPath, 'a')
    writeFileSync(secondPath, 'b')
    const fileBudget = createSshConfigExpansionBudget()
    fileBudget.fileCount = SSH_CONFIG_INCLUDE_LIMITS.files - 1

    expect(readSshConfigSourceFile(firstPath, fileBudget)).toBe('a')
    expect(readSshConfigSourceFile(secondPath, fileBudget)).toBeNull()

    const byteBudget = createSshConfigExpansionBudget()
    byteBudget.sourceBytes = SSH_CONFIG_INCLUDE_LIMITS.sourceBytes - 1
    expect(readSshConfigSourceFile(firstPath, byteBudget)).toBe('a')
    expect(readSshConfigSourceFile(secondPath, byteBudget)).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('file count exceeds 1024'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sources exceed 16777216 bytes'))
  })

  it('caps expanded output at 16 MiB or 200,000 lines', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const byteBudget = createSshConfigExpansionBudget()
    byteBudget.expandedBytes = SSH_CONFIG_INCLUDE_LIMITS.expandedBytes - 1
    const byteLines = ['']
    appendSshConfigExpandedLine(byteLines, '', byteBudget)
    expect(byteBudget.expandedBytes).toBe(SSH_CONFIG_INCLUDE_LIMITS.expandedBytes)
    appendSshConfigExpandedLine(byteLines, '', byteBudget)
    expect(byteBudget.outputTruncated).toBe(true)

    const lineBudget = createSshConfigExpansionBudget()
    lineBudget.expandedLines = SSH_CONFIG_INCLUDE_LIMITS.expandedLines
    appendSshConfigExpandedLine([], 'Host overflow', lineBudget)
    expect(lineBudget.outputTruncated).toBe(true)
  })
})
