import { describe, it, expect } from 'vitest'
import { classifyError } from './classify-error'

describe('classifyError', () => {
  it('classifies ENOENT as binary_not_found', () => {
    expect(classifyError(new Error('spawn zsh ENOENT'))).toEqual({
      error_class: 'binary_not_found'
    })
    expect(classifyError(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toEqual({
      error_class: 'binary_not_found'
    })
  })

  it('keeps shell-output-shaped not-found messages unknown', () => {
    expect(classifyError(new Error('command not found: claude'))).toEqual({
      error_class: 'unknown'
    })
    expect(classifyError(new Error('workspace not found'))).toEqual({
      error_class: 'unknown'
    })
    expect(
      classifyError(
        Object.assign(new Error('socket missing'), { code: 'ENOENT', syscall: 'connect' })
      )
    ).toEqual({ error_class: 'unknown' })
  })
})
