// Pin identifier shapes from live agent transcripts so the commit-time scrub gate cannot leak account IDs.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  formatFindings,
  redactTranscript,
  scanTranscriptForSecrets
} from './pty-transcript-secret-scan.mjs'

describe('pty transcript secret scan', () => {
  it('finds credentials an agent may echo while signing in', () => {
    const kinds = scanTranscriptForSecrets(
      [
        'token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP',
        'key: AIzaSyA1234567890abcdefghijklmnopqrstu',
        'refresh: 1//0gLm34XyZabcdefghijklmnopqrstuvwx',
        'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'
      ].join('\n')
    ).map((finding) => finding.kind)
    expect(kinds).toEqual(['jwt', 'google-api-key', 'google-refresh-token', 'bearer-token'])
  })

  it('finds the resumable conversation id agy prints on exit', () => {
    const findings = scanTranscriptForSecrets(
      'Resume with -c (or command below):\nagy --conversation=26dc1986-9eec-456a-a534-d93e5c1076c2'
    )
    expect(findings).toHaveLength(1)
    expect(findings[0].kind).toBe('uuid')
  })
})

describe('redaction', () => {
  it('leaves the rest of the screen byte-for-byte untouched', () => {
    const text = 'line one\nuser@corp.io\nline three'
    expect(redactTranscript(text).text).toBe('line one\nXXXXXXXXXXXX\nline three')
  })
})

describe('committed transcripts', () => {
  // Enforce in CI: recorder warnings can be skipped, while committed transcripts persist.
  const fixtureDir = join(
    import.meta.dirname,
    '../../..',
    '..',
    'src',
    'main',
    'runtime',
    '__fixtures__'
  )
  const transcripts = readdirSync(fixtureDir).filter((entry) => entry.endsWith('.txt'))

  it.each(transcripts)('%s carries no account identifier or credential', (name) => {
    const findings = scanTranscriptForSecrets(readFileSync(join(fixtureDir, name), 'utf8'))
    expect(findings, formatFindings(name, findings)).toEqual([])
  })
})
