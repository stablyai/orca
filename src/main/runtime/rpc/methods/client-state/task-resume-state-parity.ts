import type { z } from 'zod'
import type { TaskResumeState as TaskResumeStateType } from '../../../../../shared/ui-chrome-types'
import type { AssertNoMissingKeys } from './ui-state-schema-parity'
import type { TaskResumeState } from '../../../../../shared/rpc-contract/task-resume-state-params'
import '../../../../../shared/rpc-contract/task-resume-state-params'

const _taskResumeStateParity: AssertNoMissingKeys<
  TaskResumeStateType,
  z.infer<typeof TaskResumeState>
> = true
void _taskResumeStateParity
