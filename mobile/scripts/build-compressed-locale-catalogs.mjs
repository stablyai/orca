import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { ensureCompressedLocaleCatalogsSync } = require('./sync-compressed-locale-catalogs.cjs')

ensureCompressedLocaleCatalogsSync()
