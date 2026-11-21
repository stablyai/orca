import { describe, expect, it } from 'vitest'
import { SendParams } from './send-params'

describe('SendParams worker_done body', () => {
  // '' is normalized away before refinement unless the schema keeps it; '   ' needs the trim check.
  it.each(['', '   '])('refuses a blank worker_done body (%j)', (body) => {
    const parsed = SendParams.safeParse({ subject: 'Done', type: 'worker_done', body })
    expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([['body']])
  })
})
