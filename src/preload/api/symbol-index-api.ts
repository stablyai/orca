import type {
  FindDefinitionsRequest,
  FindDefinitionsResponse
} from '../../shared/symbol-index'

export type SymbolIndexApi = {
  findDefinitions: (req: FindDefinitionsRequest) => Promise<FindDefinitionsResponse>
  ensureIndexed: (args: { worktreeId: string; worktreeRoot: string }) => Promise<void>
}
