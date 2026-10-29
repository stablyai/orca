import { loader } from 'fumadocs-core/source'
import { docs } from '../../.source/server'

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource()
})
