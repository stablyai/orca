import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_HOSTED_REVIEW_TEMPLATE_BYTES, readHostedReviewTemplate } from './pull-request-template'

describe('readHostedReviewTemplate', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function makeRepo(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'orca-review-template-'))
    roots.push(root)
    await mkdir(join(root, '.github'), { recursive: true })
    return root
  }

  it('preserves the first conventional template under the limit', async () => {
    const repoPath = await makeRepo()
    await writeFile(join(repoPath, '.github', 'pull_request_template.md'), 'normal template\n')
    await writeFile(join(repoPath, 'PULL_REQUEST_TEMPLATE.md'), 'fallback\n')

    await expect(readHostedReviewTemplate(repoPath)).resolves.toBe('normal template\n')
  })

  it('skips an oversized sparse template and reads the next candidate', async () => {
    const repoPath = await makeRepo()
    const oversizedPath = join(repoPath, '.github', 'pull_request_template.md')
    await writeFile(oversizedPath, 'x')
    await truncate(oversizedPath, MAX_HOSTED_REVIEW_TEMPLATE_BYTES + 1)
    await writeFile(join(repoPath, '.github', 'PULL_REQUEST_TEMPLATE.md'), 'bounded fallback\n')

    await expect(readHostedReviewTemplate(repoPath)).resolves.toBe('bounded fallback\n')
  })

  it('accepts a template exactly at the byte limit', async () => {
    const repoPath = await makeRepo()
    const body = 'a'.repeat(MAX_HOSTED_REVIEW_TEMPLATE_BYTES)
    await writeFile(join(repoPath, '.github', 'pull_request_template.md'), body)

    await expect(readHostedReviewTemplate(repoPath)).resolves.toHaveLength(
      MAX_HOSTED_REVIEW_TEMPLATE_BYTES
    )
  })
})
