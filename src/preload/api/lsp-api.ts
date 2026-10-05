import type {
  LspOpenArgs,
  LspOpenResult,
  LspProbeArgs,
  LspProbeResult
} from '../../shared/language-server-types'

export type LspApi = {
  open: (args: LspOpenArgs) => Promise<LspOpenResult>
  probe: (args: LspProbeArgs) => Promise<LspProbeResult>
}
