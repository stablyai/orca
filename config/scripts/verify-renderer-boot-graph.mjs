import process from 'node:process'

import { verifyRendererBootGraph } from './desktop-build/output-contracts/renderer-boot-graph.mjs'

process.exit(verifyRendererBootGraph())
