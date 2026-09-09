import { describe, expect, it } from 'vitest'
import { mergeHermesOutputAndSessionRuns } from './hermes-run-correlation'

function run(runKey: string, content: string): Record<string, unknown> {
  return {
    id: runKey,
    run_key: runKey,
    output_preview: content,
    output_content: content
  }
}

describe('mergeHermesOutputAndSessionRuns', () => {
  it('prefers an exact run key and appends its full session transcript', () => {
    const output = run('20260516_090000', 'summary')
    const exact = run('20260516_090000', 'exact transcript')
    const nearerButDifferent = run('20260516_085959', 'other transcript')

    const result = mergeHermesOutputAndSessionRuns([output], [nearerButDifferent, exact]) as Record<
      string,
      unknown
    >[]

    expect(result[0].output_content).toBe(
      'summary\n\n---\n\n## Full session log\n\nexact transcript'
    )
    expect(result[1]).toBe(nearerButDifferent)
  })

  it('matches only the nearest earlier session inside the 24-hour window', () => {
    const output = run('20260516_090000', 'summary')
    const later = run('20260516_090001', 'later')
    const tooOld = run('20260515_085959', 'too old')
    const nearestEarlier = run('20260516_085959', 'nearest earlier')

    const result = mergeHermesOutputAndSessionRuns(
      [output],
      [later, tooOld, nearestEarlier]
    ) as Record<string, unknown>[]

    expect(result[0].output_content).toContain('nearest earlier')
    expect(result.slice(1)).toEqual([later, tooOld])
  })

  it('uses each session run at most once', () => {
    const first = run('20260516_090000', 'first')
    const second = run('20260516_090100', 'second')
    const session = run('20260516_085900', 'one transcript')

    const result = mergeHermesOutputAndSessionRuns([first, second], [session]) as Record<
      string,
      unknown
    >[]

    expect(
      result.filter((item) => String(item.output_content).includes('one transcript'))
    ).toHaveLength(1)
  })
})
