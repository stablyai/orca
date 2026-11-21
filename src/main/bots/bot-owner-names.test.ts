import { beforeEach, describe, expect, it, vi } from 'vitest'

const runProcess = vi.fn()
vi.mock('@orca/process-host', () => ({ runProcess }))

async function freshNames(): Promise<() => Promise<string[]>> {
  vi.resetModules()
  return (await import('./bot-owner-names')).hostOwnerNames
}

describe("the owner's names as this computer knows them", () => {
  beforeEach(() => {
    runProcess.mockReset()
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })

  it('keeps every word of a name, minus short and generic words', async () => {
    runProcess.mockResolvedValue({ code: 0, stdout: 'Dana Al Root-Smith Bot\n' })
    const names = await (await freshNames())()
    expect(names).toEqual(['Dana', 'Root-Smith'])
  })

  it('reads again after an empty read, and keeps a read that found names', async () => {
    const hostOwnerNames = await freshNames()
    runProcess.mockResolvedValue({ code: 1, stdout: '' })
    expect(await hostOwnerNames()).toEqual([])
    runProcess.mockResolvedValue({ code: 0, stdout: 'Dana' })
    expect(await hostOwnerNames()).toEqual(['Dana'])
    runProcess.mockResolvedValue({ code: 0, stdout: 'Someone Else' })
    expect(await hostOwnerNames()).toEqual(['Dana'])
  })
})
