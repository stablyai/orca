import { DEFAULT_READ_SCOPE, READ_SCOPE_KEY, type ReadScope } from '../storage/speech-preferences'
import { createStoredChoice } from './stored-choice'

const useReadScopeChoice = createStoredChoice<ReadScope>(
  READ_SCOPE_KEY,
  ['all', 'all-on-screen', 'replies'],
  DEFAULT_READ_SCOPE
)

export function useReadScopePreference(): {
  readScope: ReadScope
  setReadScope: (next: ReadScope) => void
} {
  const { value, setValue } = useReadScopeChoice()
  return { readScope: value, setReadScope: setValue }
}
