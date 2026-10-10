// Why: the pty IPC suites force darwin and rewrite a dozen agent-home env vars per test;
// this scope captures the real values once and puts them back afterwards.
export function createPtyIpcProcessEnvScope() {
  const savedOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR
  const savedOrcaOpenCodeConfigDir = process.env.ORCA_OPENCODE_CONFIG_DIR
  const savedOrcaOpenCodeSourceConfigDir = process.env.ORCA_OPENCODE_SOURCE_CONFIG_DIR
  const savedPiAgentDir = process.env.PI_CODING_AGENT_DIR
  const savedOrcaPiAgentDir = process.env.ORCA_PI_CODING_AGENT_DIR
  const savedOrcaPiSourceAgentDir = process.env.ORCA_PI_SOURCE_AGENT_DIR
  const savedOrcaCodexHome = process.env.ORCA_CODEX_HOME
  const savedOrcaOmpAgentDir = process.env.ORCA_OMP_CODING_AGENT_DIR
  const savedOrcaOmpSourceAgentDir = process.env.ORCA_OMP_SOURCE_AGENT_DIR
  const savedOrcaOmpStatusExtension = process.env.ORCA_OMP_STATUS_EXTENSION
  const savedPrimeAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR
  const savedOrcaPrimeAgentSourceDir = process.env.ORCA_PRIME_AGENT_SOURCE_AGENT_DIR
  const savedOrcaPrimeAgentStatusExtension = process.env.ORCA_PRIME_AGENT_STATUS_EXTENSION
  const savedOrcaClaudeAgentStatusSettings = process.env.ORCA_CLAUDE_AGENT_STATUS_SETTINGS
  const savedProcessPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const savedDisableMacosLoginShell = process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL
  const savedOrcaUserDataPath = process.env.ORCA_USER_DATA_PATH

  function applyTestEnvDefaults() {
    // Why: most PTY spawn tests assert POSIX shell behavior; Windows cases opt into win32 explicitly below.
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin'
    })
    // Why: forced darwin makes the TCC login(1) wrapper rewrite every asserted argv; its own test below re-enables it.
    process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL = '1'
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.ORCA_OPENCODE_SOURCE_CONFIG_DIR
    delete process.env.ORCA_OPENCODE_CONFIG_DIR
    delete process.env.ORCA_AGENT_HOOK_ENDPOINT
    delete process.env.ORCA_CLAUDE_AGENT_STATUS_SETTINGS
    delete process.env.PI_CODING_AGENT_DIR
    delete process.env.ORCA_PI_SOURCE_AGENT_DIR
    delete process.env.ORCA_PI_CODING_AGENT_DIR
    delete process.env.ORCA_CODEX_HOME
    delete process.env.ORCA_OMP_SOURCE_AGENT_DIR
    delete process.env.ORCA_OMP_CODING_AGENT_DIR
    delete process.env.ORCA_OMP_STATUS_EXTENSION
    delete process.env.PRIME_AGENT_CODING_AGENT_DIR
    delete process.env.ORCA_PRIME_AGENT_SOURCE_AGENT_DIR
    delete process.env.ORCA_PRIME_AGENT_STATUS_EXTENSION
  }

  function restoreProcessEnv() {
    if (savedProcessPlatform) {
      Object.defineProperty(process, 'platform', savedProcessPlatform)
    }
    if (savedDisableMacosLoginShell !== undefined) {
      process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL = savedDisableMacosLoginShell
    } else {
      delete process.env.ORCA_DISABLE_MACOS_LOGIN_SHELL
    }
    if (savedOrcaUserDataPath !== undefined) {
      process.env.ORCA_USER_DATA_PATH = savedOrcaUserDataPath
    } else {
      delete process.env.ORCA_USER_DATA_PATH
    }
    if (savedOpenCodeConfigDir !== undefined) {
      process.env.OPENCODE_CONFIG_DIR = savedOpenCodeConfigDir
    } else {
      delete process.env.OPENCODE_CONFIG_DIR
    }
    if (savedOrcaOpenCodeConfigDir !== undefined) {
      process.env.ORCA_OPENCODE_CONFIG_DIR = savedOrcaOpenCodeConfigDir
    } else {
      delete process.env.ORCA_OPENCODE_CONFIG_DIR
    }
    if (savedOrcaOpenCodeSourceConfigDir !== undefined) {
      process.env.ORCA_OPENCODE_SOURCE_CONFIG_DIR = savedOrcaOpenCodeSourceConfigDir
    } else {
      delete process.env.ORCA_OPENCODE_SOURCE_CONFIG_DIR
    }
    if (savedPiAgentDir !== undefined) {
      process.env.PI_CODING_AGENT_DIR = savedPiAgentDir
    } else {
      delete process.env.PI_CODING_AGENT_DIR
    }
    if (savedOrcaPiAgentDir !== undefined) {
      process.env.ORCA_PI_CODING_AGENT_DIR = savedOrcaPiAgentDir
    } else {
      delete process.env.ORCA_PI_CODING_AGENT_DIR
    }
    if (savedOrcaPiSourceAgentDir === undefined) {
      delete process.env.ORCA_PI_SOURCE_AGENT_DIR
    } else {
      process.env.ORCA_PI_SOURCE_AGENT_DIR = savedOrcaPiSourceAgentDir
    }
    if (savedOrcaCodexHome === undefined) {
      delete process.env.ORCA_CODEX_HOME
    } else {
      process.env.ORCA_CODEX_HOME = savedOrcaCodexHome
    }
    if (savedOrcaOmpAgentDir !== undefined) {
      process.env.ORCA_OMP_CODING_AGENT_DIR = savedOrcaOmpAgentDir
    } else {
      delete process.env.ORCA_OMP_CODING_AGENT_DIR
    }
    if (savedOrcaOmpSourceAgentDir !== undefined) {
      process.env.ORCA_OMP_SOURCE_AGENT_DIR = savedOrcaOmpSourceAgentDir
    } else {
      delete process.env.ORCA_OMP_SOURCE_AGENT_DIR
    }
    if (savedOrcaOmpStatusExtension !== undefined) {
      process.env.ORCA_OMP_STATUS_EXTENSION = savedOrcaOmpStatusExtension
    } else {
      delete process.env.ORCA_OMP_STATUS_EXTENSION
    }
    if (savedPrimeAgentDir !== undefined) {
      process.env.PRIME_AGENT_CODING_AGENT_DIR = savedPrimeAgentDir
    } else {
      delete process.env.PRIME_AGENT_CODING_AGENT_DIR
    }
    if (savedOrcaPrimeAgentSourceDir !== undefined) {
      process.env.ORCA_PRIME_AGENT_SOURCE_AGENT_DIR = savedOrcaPrimeAgentSourceDir
    } else {
      delete process.env.ORCA_PRIME_AGENT_SOURCE_AGENT_DIR
    }
    if (savedOrcaPrimeAgentStatusExtension !== undefined) {
      process.env.ORCA_PRIME_AGENT_STATUS_EXTENSION = savedOrcaPrimeAgentStatusExtension
    } else {
      delete process.env.ORCA_PRIME_AGENT_STATUS_EXTENSION
    }
    if (savedOrcaClaudeAgentStatusSettings === undefined) {
      delete process.env.ORCA_CLAUDE_AGENT_STATUS_SETTINGS
    } else {
      process.env.ORCA_CLAUDE_AGENT_STATUS_SETTINGS = savedOrcaClaudeAgentStatusSettings
    }
  }

  return { applyTestEnvDefaults, restoreProcessEnv }
}
