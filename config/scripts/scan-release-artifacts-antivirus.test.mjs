import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  formatArtifactReport,
  hasAnyDetection,
  hashFile,
  summarizeEngineVerdicts
} from './scan-release-artifacts-antivirus.mjs'

describe('antivirus detection report', () => {
  it('hashes an artifact with the same digest the issue reports quote', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-av-scan-'))
    try {
      const artifact = join(directory, 'orca-windows-setup.exe')
      await writeFile(artifact, 'orca', 'utf8')
      // Lowercase hex sha256, so a reporter's `shasum -a 256` output and ours
      // compare directly — that comparison is what makes a submission credible.
      expect(await hashFile(artifact)).toBe(
        'e0c924608fdcda8536bd9cc86b0fce0ab2d54ecc1e8ed9673624c39cde7f7820'
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('counts only malicious and suspicious categories as verdicts', () => {
    const { scanned, flagged } = summarizeEngineVerdicts({
      Microsoft: { category: 'malicious', result: 'Trojan:Win32/Wacatac.B!ml' },
      Bitdefender: { category: 'suspicious', result: 'Gen:Variant.MSILHeracles' },
      Kaspersky: { category: 'undetected', result: null },
      ESET: { category: 'type-unsupported', result: null },
      Avast: { category: 'timeout', result: null }
    })

    expect(scanned).toBe(5)
    expect(flagged).toEqual([
      { engine: 'Bitdefender', category: 'suspicious', detection: 'Gen:Variant.MSILHeracles' },
      { engine: 'Microsoft', category: 'malicious', detection: 'Trojan:Win32/Wacatac.B!ml' }
    ])
  })

  it('treats a missing results payload as nothing scanned rather than clean', () => {
    expect(summarizeEngineVerdicts(undefined)).toEqual({ scanned: 0, flagged: [] })
    expect(summarizeEngineVerdicts(null)).toEqual({ scanned: 0, flagged: [] })
  })

  it('names an unnamed detection instead of printing undefined', () => {
    const { flagged } = summarizeEngineVerdicts({ Sophos: { category: 'malicious' } })
    expect(flagged[0].detection).toBe('<unnamed>')
  })

  it('distinguishes an unscanned build from a clean one', () => {
    const unscanned = formatArtifactReport({
      name: 'orca-windows-setup.exe',
      sha256: 'a'.repeat(64),
      known: false,
      scanned: 0,
      flagged: []
    })
    expect(unscanned).toContain('never been scanned')

    const clean = formatArtifactReport({
      name: 'orca-windows-setup.exe',
      sha256: 'a'.repeat(64),
      known: true,
      scanned: 70,
      flagged: []
    })
    expect(clean).toContain('clean across 70 engines')
  })

  it('reports every flagging engine and its detection name', () => {
    const report = formatArtifactReport({
      name: 'orca.exe',
      sha256: 'b'.repeat(64),
      known: true,
      scanned: 70,
      flagged: [
        { engine: 'TrendMicro', category: 'malicious', detection: 'Trojan.MSIL.MSILHERACLES' }
      ]
    })

    expect(report).toContain('1 of 70 engines flag this build')
    expect(report).toContain('TrendMicro: Trojan.MSIL.MSILHERACLES')
  })

  it('flags the release when any single artifact carries a verdict', () => {
    const clean = { flagged: [] }
    const flagged = { flagged: [{ engine: 'Microsoft' }] }

    expect(hasAnyDetection([clean, clean])).toBe(false)
    expect(hasAnyDetection([clean, flagged])).toBe(true)
  })
})
