const EXTERNAL_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

export function assertExternalAutomationJobId(jobId: string): void {
  if (!EXTERNAL_JOB_ID_PATTERN.test(jobId)) {
    throw new Error('Invalid external automation job ID.')
  }
}
