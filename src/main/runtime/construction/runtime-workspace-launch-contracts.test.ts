import { registerOrcaRuntimeEmulatorFolderWorkspaceTests } from '../emulator/orca-runtime-emulator-folder-workspace.spec'
import { registerOrcaRuntimeAutomationsTests } from '../integrations/automations/orca-runtime-automations.spec'
import { registerHostAccountLaunchEnvTests } from '../agent-session/environment/host-account-launch-env.spec'

registerOrcaRuntimeEmulatorFolderWorkspaceTests()
registerOrcaRuntimeAutomationsTests()
registerHostAccountLaunchEnvTests()
