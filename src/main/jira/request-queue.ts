import { createRequestConcurrencyQueue } from '../network/request-concurrency-queue'

const MAX_CONCURRENT = 4

const jiraRequestQueue = createRequestConcurrencyQueue(MAX_CONCURRENT, 'Jira')

export const acquire = jiraRequestQueue.acquire
export const release = jiraRequestQueue.release
