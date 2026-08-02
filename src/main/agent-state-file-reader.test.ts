import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeFileReadTooLargeError } from '../shared/node-bounded-file-reader'
import {
  MAX_AGENT_STATE_FILE_BYTES,
  MAX_AGENT_STATE_JSON_NESTING_DEPTH,
  MAX_AGENT_STATE_JSON_STRUCTURAL_TOKENS,
  readAgentStateFileSync,
  readAgentStateJsonFileSync
} from './agent-state-file-reader'

const tempDirs: string[] = []

function tempFile(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-agent-state-'))
  tempDirs.push(directory)
  return join(directory, name)
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('readAgentStateFileSync', () => {
  it('preserves normal UTF-8 auth and config contents', () => {
    const filePath = tempFile('auth.json')
    const contents = '{"token":"你好","refresh":"abc"}\n'
    writeFileSync(filePath, contents)

    expect(readAgentStateFileSync(filePath)).toBe(contents)
  })

  it('reads a sparse file at the exact 4 MiB boundary', () => {
    const filePath = tempFile('snapshot.json')
    writeFileSync(filePath, '')
    truncateSync(filePath, MAX_AGENT_STATE_FILE_BYTES)

    const contents = readAgentStateFileSync(filePath)

    expect(contents).toHaveLength(MAX_AGENT_STATE_FILE_BYTES)
    expect(contents.charCodeAt(MAX_AGENT_STATE_FILE_BYTES - 1)).toBe(0)
  })

  it('rejects a sparse file one byte over the boundary before reading its payload', () => {
    const filePath = tempFile('oversized.json')
    writeFileSync(filePath, '')
    truncateSync(filePath, MAX_AGENT_STATE_FILE_BYTES + 1)

    expect(() => readAgentStateFileSync(filePath)).toThrow(NodeFileReadTooLargeError)
  })
})

describe('readAgentStateJsonFileSync', () => {
  it('preserves ordinary JSON values', () => {
    const filePath = tempFile('auth.json')
    writeFileSync(filePath, '{"token":"你好","nested":{"enabled":true}}')

    expect(readAgentStateJsonFileSync(filePath)).toEqual({
      token: '你好',
      nested: { enabled: true }
    })
  })

  it('rejects structural-token and nesting amplification before JSON.parse', () => {
    const structuralPath = tempFile('structural.json')
    writeFileSync(structuralPath, `[${'0,'.repeat(MAX_AGENT_STATE_JSON_STRUCTURAL_TOKENS)}0]`)
    const nestedPath = tempFile('nested.json')
    writeFileSync(
      nestedPath,
      `${'['.repeat(MAX_AGENT_STATE_JSON_NESTING_DEPTH + 1)}0${']'.repeat(
        MAX_AGENT_STATE_JSON_NESTING_DEPTH + 1
      )}`
    )

    expect(() => readAgentStateJsonFileSync(structuralPath)).toThrow('JSON structure exceeds')
    expect(() => readAgentStateJsonFileSync(nestedPath)).toThrow('JSON nesting exceeds')
  })
})
