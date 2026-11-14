import type { RuntimeEdgeCommandSurface } from './runtime-edge-command-controller'
import type { RuntimeLinearCommandSurface } from '../integrations/linear/runtime-linear-command-surface'
import type { RuntimeFileCommandSurface } from './runtime-file-command-surface'
import type { RuntimeGitCommandSurface } from '../integrations/git/runtime-git-command-surface'
import type { RuntimeRepositoryCommandSurface } from '../repositories/runtime-repository-command-surface'
import type { RuntimeReviewCommandSurface } from './runtime-review-command-surface'
import type { RuntimeServiceCommandSurface } from './runtime-service-command-surface'
import type { RuntimeSkillCommandSurface } from '../integrations/skill/runtime-skill-command-contract'

type RuntimeInstalledCommandSurfaces = RuntimeEdgeCommandSurface &
  RuntimeLinearCommandSurface &
  RuntimeFileCommandSurface &
  RuntimeGitCommandSurface &
  RuntimeRepositoryCommandSurface &
  RuntimeReviewCommandSurface &
  RuntimeServiceCommandSurface &
  RuntimeSkillCommandSurface

export type RuntimeCommandSurfaceHost<T> = T & RuntimeInstalledCommandSurfaces
