import { describe, expect, it } from 'vitest'
import { DaemonRecoveryCredit } from '../daemon-client-recovery-credit'

const never = (): Promise<string> => new Promise(() => {})
const answered = (): Promise<string> => Promise.resolve('snapshot')

function fillOwed(credit: DaemonRecoveryCredit, firstSeq: number): void {
  for (let i = 0; i < 8; i++) {
    void credit.send(`s${i}`, firstSeq + i, never, never)
  }
}

describe('DaemonRecoveryCredit', () => {
  it('stops writing snapshots to a daemon that reads nothing, probes once, and resumes on the probe reply', async () => {
    const credit = new DaemonRecoveryCredit()
    const probes: number[] = []
    fillOwed(credit, 1)
    const probe = (seq: number) => () => {
      probes.push(seq)
      return never()
    }
    expect(await credit.send('s9', 9, answered, probe(9))).toBeNull()
    expect(await credit.send('s10', 10, answered, probe(10))).toBeNull()
    expect(probes).toEqual([9])
    credit.observeReply('req-9')
    expect(await credit.send('s9', 10, answered, probe(10))).toBe('snapshot')
  })

  it('lets other sessions through when a later request is answered past stuck snapshots', async () => {
    const credit = new DaemonRecoveryCredit()
    fillOwed(credit, 1)
    credit.observeReply('req-20')
    expect(await credit.send('s9', 21, answered, never)).toBe('snapshot')
  })

  it('keeps the credit when only an earlier request is answered', async () => {
    const credit = new DaemonRecoveryCredit()
    fillOwed(credit, 5)
    credit.observeReply('req-3')
    expect(await credit.send('s9', 13, answered, never)).toBeNull()
  })

  it('allows one unanswered snapshot per session until it is read', async () => {
    const credit = new DaemonRecoveryCredit()
    void credit.send('s1', 1, never, never)
    expect(await credit.send('s1', 2, answered, never)).toBeNull()
    expect(await credit.send('s2', 3, answered, never)).toBe('snapshot')
    credit.observeReply('req-1')
    expect(await credit.send('s1', 4, answered, never)).toBe('snapshot')
  })

  it('probes for a lone stuck session on an otherwise idle daemon and resumes on the probe reply', async () => {
    const credit = new DaemonRecoveryCredit()
    const probes: number[] = []
    const probe = (seq: number) => () => {
      probes.push(seq)
      return never()
    }
    void credit.send('s1', 1, never, never)
    expect(await credit.send('s1', 2, answered, probe(2))).toBeNull()
    expect(await credit.send('s1', 3, answered, probe(3))).toBeNull()
    expect(probes).toEqual([2])
    credit.observeReply('req-2')
    expect(await credit.send('s1', 3, answered, probe(3))).toBe('snapshot')
  })

  it('starts a new connection with nothing owed', async () => {
    const credit = new DaemonRecoveryCredit()
    fillOwed(credit, 1)
    credit.reset()
    expect(await credit.send('s9', 9, answered, never)).toBe('snapshot')
  })
})
