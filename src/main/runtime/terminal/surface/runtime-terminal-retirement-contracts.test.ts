import { registerOrcaRuntimeTerminalCloseSpillPartitionTests } from './orca-runtime-terminal-close-spill-partition.spec'
import { registerPairedCloseRetirementProofPublicationOrderTests } from '../../orca-runtime-tests/paired-close-retirement-proof-publication-order.spec'
import { registerOrcaRuntimeTerminalRetirementHostPartitionTests } from './orca-runtime-terminal-retirement-host-partition.spec'
import { registerRuntimeRemoveProjectHostScopeTests } from '../../orca-runtime-tests/runtime-remove-project-host-scope.spec'

registerOrcaRuntimeTerminalCloseSpillPartitionTests()
registerPairedCloseRetirementProofPublicationOrderTests()
registerOrcaRuntimeTerminalRetirementHostPartitionTests()
registerRuntimeRemoveProjectHostScopeTests()
