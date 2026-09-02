import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

export const CLIENT_ID = randomUUID()
export const CLIENT_NAME = hostname() || 'This device'
