import { describe, expect, it } from 'vitest'
import { getCompiledSchema } from '../../../../../schema-validation/zod-schema-compilation'
import { SendParams } from './send-params'

describe('SendParams worker_done body', () => {
  // `--body "$(cat missing-file)"` expands to ''; '' must reach the check, and '   ' needs the trim.
  it.each(['', '   '])('refuses a blank worker_done body (%j)', (body) => {
    const parsed = getCompiledSchema(SendParams).safeParse({
      subject: 'Done',
      type: 'worker_done',
      body
    })
    expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([['body']])
  })
})
