import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const script = readFileSync('config/windows-signing/verify-inner.ps1', 'utf8')
const jobs = parse(readFileSync('.github/workflows/release-windows-signing.yml', 'utf8')).jobs

describe('shipped Windows signature evidence', () => {
  it('shares the shipped-payload verifier between production and rehearsal', () => {
    for (const name of ['release-cut', 'windows-signing-rehearsal']) {
      const caller = parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8'))
      expect(
        Object.values(caller.jobs).some(
          (job) => job.uses === './.github/workflows/release-windows-signing.yml'
        )
      ).toBe(true)
    }
    expect(
      jobs.finalize.steps.find((step) => step.name === 'Verify Windows inner binary signatures').run
    ).toContain('/config/windows-signing/verify-inner.ps1')
  })
  it('resolves the installed toolset and checks all native command exits', () => {
    expect(script).toContain('node config/scripts/resolve-7za-path.mjs')
    expect(script).not.toContain('node_modules/7zip-bin')
    expect(script.match(/if \(\$LASTEXITCODE -ne 0\) \{ throw /g)).toHaveLength(3)
    expect(script).toContain("-PathType Leaf)) { throw 'Invalid installer extractor.' }")
  })
  it('always verifies elevate and writes evidence on failure', () => {
    expect(script).toContain("$targets += 'resources\\elevate.exe'")
    expect(script).toContain('Assert-SigningCertificate $signature $relative')
    expect(script).toContain('} finally {')
    expect(script).toContain("Set-Content -LiteralPath 'inner-signing-evidence.txt'")
    expect(script).toContain('VERDICT: FAILED')
    expect(script).not.toContain('exit 0')
    expect(script).not.toContain('$required')
    const evidence = jobs.finalize.steps.find(
      (step) => step.name === 'Upload Windows inner signing evidence'
    )
    expect(evidence.if).toBe('always()')
    expect(evidence.with.name).toContain('${{ github.run_attempt }}')
    expect(evidence.with.path).toContain('inner-signing-evidence.txt')
  })
})
