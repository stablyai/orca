import { describe, expect, it } from 'vitest'
import { parseClickUpTaskReference } from './clickup-task-reference'

describe('parseClickUpTaskReference', () => {
  it.each([
    ['86abc123', '86abc123'],
    [' 86abc123 ', '86abc123'],
    ['https://app.clickup.com/t/86abc123', '86abc123'],
    ['https://app.clickup.com/t/86abc123/task-title?view=detail', '86abc123']
  ])('normalizes %s', (input, expected) => {
    expect(parseClickUpTaskReference(input)).toBe(expected)
  })

  it.each([
    'https://app.clickup.com.evil.example/t/86abc123',
    'http://app.clickup.com/t/86abc123',
    'https://app.clickup.com/t/',
    'https://app.clickup.com/t/%2Fetc',
    'not a task'
  ])('rejects invalid task reference %s', (input) => {
    expect(parseClickUpTaskReference(input)).toBeNull()
  })
})
