import { expect, it } from 'vitest'
import { mapOpenClawJobs } from './openclaw-job-records'

it('keeps the full prompt for search while the list preview stays truncated', () => {
  const prompt =
    'Read the repository and collect the results of the scheduled maintenance tasks. Include every failed check and its diagnostic details. Finish with the deployment checklist.'
  const [job] = mapOpenClawJobs('openclaw:local', [
    { id: 'maintenance', payload: { message: prompt } }
  ])
  expect(job.prompt).toBe(prompt)
  expect(job.promptPreview).toBe(`${prompt.slice(0, 117)}...`)
})
