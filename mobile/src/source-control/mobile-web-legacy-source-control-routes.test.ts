import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const nativeHistory = readFileSync(
  new URL('../../app/h/[hostId]/history/[worktreeId].tsx', import.meta.url),
  'utf8'
)
const nativeReview = readFileSync(
  new URL('../../app/h/[hostId]/pr/[worktreeId].tsx', import.meta.url),
  'utf8'
)
const hostedHistory = readFileSync(
  new URL('../../host-web-app/h/[hostId]/history/[worktreeId].tsx', import.meta.url),
  'utf8'
)
const hostedReview = readFileSync(
  new URL('../../host-web-app/h/[hostId]/pr/[worktreeId].tsx', import.meta.url),
  'utf8'
)

describe('mobile web legacy source-control routes', () => {
  it('reuses provider-neutral native redirects in the hosted router', () => {
    expect(hostedHistory).toContain("from '../../../../app/h/[hostId]/history/[worktreeId]'")
    expect(hostedReview).toContain("from '../../../../app/h/[hostId]/pr/[worktreeId]'")
    expect(nativeHistory).toContain("tab: 'history'")
    expect(nativeReview).toContain("tab: 'pr'")
    expect(`${nativeHistory}${nativeReview}`).not.toMatch(/github|gitlab/i)
  })
})
