import process from 'node:process'

import { verifyRendererBootGraph } from './renderer-boot-graph.mjs'

process.exit(verifyRendererBootGraph())
