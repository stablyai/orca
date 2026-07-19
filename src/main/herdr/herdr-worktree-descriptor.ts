import type { Worktree } from '../../shared/types'

export type HerdrWorktreeDescriptor = Pick<Worktree, 'id' | 'instanceId' | 'path' | 'displayName'>
