import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  isRelayCellConnectionHardCap,
  RELAY_ADMISSION_BUDGETS,
  RELAY_CELL_ADMISSION_BOUNDS,
  RELAY_CELL_CONNECTION_HARD_CAP,
  RELAY_CELL_CONNECTION_HARD_CAPS,
  relayCellAdmissionBounds
} from '@orca-cloud/relay-contract'
import { describe, expect, it } from 'vitest'

// Why: dev scripts run standalone in CI and Terraform cannot read TypeScript, so neither can
// import the constant. Both restate it instead. This asserts every restatement still agrees, so
// raising the cap fails loudly here rather than silently leaving a surface behind.
// Repository root, and every path read below stays inside the Relay tree, so this survives the
// move under cloud/ in the public repository.
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const read = (path: string): string => readFileSync(`${repositoryRoot}${path}`, 'utf8')

describe('cell connection hard cap stays consistent across surfaces that cannot import it', () => {
  it('derives its own bounds from the cap', () => {
    expect(RELAY_CELL_ADMISSION_BOUNDS.hardCap).toBe(RELAY_CELL_CONNECTION_HARD_CAP)
    expect(RELAY_CELL_ADMISSION_BOUNDS.socketAdmissionCeiling).toBe(
      RELAY_CELL_CONNECTION_HARD_CAP - RELAY_ADMISSION_BUDGETS.reservedHostControls
    )
    expect(RELAY_CELL_ADMISSION_BOUNDS.maxUnobservedBound).toBe(
      RELAY_CELL_ADMISSION_BOUNDS.socketAdmissionCeiling - 1
    )
    for (const hardCap of RELAY_CELL_CONNECTION_HARD_CAPS) {
      const bounds = relayCellAdmissionBounds(hardCap)
      expect(bounds.socketAdmissionCeiling).toBe(
        hardCap - RELAY_ADMISSION_BUDGETS.reservedHostControls
      )
      expect(bounds.maxUnobservedBound).toBe(bounds.socketAdmissionCeiling - 1)
    }
  })

  it.each([
    ['dev/scripts/relay-recovery-wave-gate.mjs', /targetConnectionCap:\s*(\d+)/],
    ['dev/scripts/deploy-relay-gce-multi-target.mjs', /DEFAULT_CONNECTION_CEILING\s*=\s*(\d+)/],
    ['dev/scripts/deploy-relay-gce-multi-target.mjs', /CUTOVER_CONNECTION_HARD_CAP\s*=\s*(\d+)/]
  ])('%s matches the contract cap', (path, pattern) => {
    const match = read(path).match(pattern)
    expect(match, `${path} no longer declares ${pattern}`).not.toBeNull()
    expect(Number(match![1])).toBe(RELAY_CELL_CONNECTION_HARD_CAP)
  })

  it('every production cell declaring a cap uses a supported contract cap', () => {
    const declared = [
      ...read('infra/terraform/environments/production.tfvars').matchAll(
        /connection_hard_cap\s*=\s*(\d+)/g
      )
    ].map((match) => Number(match[1]))
    expect(declared.length).toBeGreaterThan(0)
    expect(new Set(declared).has(RELAY_CELL_CONNECTION_HARD_CAP)).toBe(true)
    expect(declared.every((hardCap) => isRelayCellConnectionHardCap(hardCap))).toBe(true)
  })

  it('the Terraform cell validation accepts exactly the supported contract caps', () => {
    const match = read('infra/terraform/variables.tf').match(
      /contains\(\[([^\]]+)\], cell\.connection_hard_cap\)/
    )
    expect(match, 'variables.tf no longer validates connection_hard_cap').not.toBeNull()
    expect(match![1]!.split(',').map((value) => Number(value.trim()))).toEqual([
      ...RELAY_CELL_CONNECTION_HARD_CAPS
    ])
  })

  it('the Terraform unobserved bound leaves the contract rebind reserve', () => {
    expect(read('infra/terraform/variables.tf')).toContain(
      'cell.connection_unobserved_bound < cell.connection_hard_cap - 100'
    )
  })
})
