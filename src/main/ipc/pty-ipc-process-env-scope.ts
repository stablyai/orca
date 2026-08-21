// Why: the pty IPC suites force darwin and rewrite a dozen agent-home env vars per test;
// this scope captures the real values once and puts them back afterwards.
export function createPtyIpcProcessEnvScope() {
  const savedOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR
  const savedMCodeOpenCodeConfigDir = process.env.MCODE_OPENCODE_CONFIG_DIR
  const savedMCodeOpenCodeSourceConfigDir = process.env.MCODE_OPENCODE_SOURCE_CONFIG_DIR
  const savedPiAgentDir = process.env.PI_CODING_AGENT_DIR
  const savedMCodePiAgentDir = process.env.MCODE_PI_CODING_AGENT_DIR
  const savedMCodePiSourceAgentDir = process.env.MCODE_PI_SOURCE_AGENT_DIR
  const savedMCodeCodexHome = process.env.MCODE_CODEX_HOME
  const savedMCodeOmpAgentDir = process.env.MCODE_OMP_CODING_AGENT_DIR
  const savedMCodeOmpSourceAgentDir = process.env.MCODE_OMP_SOURCE_AGENT_DIR
  const savedMCodeOmpStatusExtension = process.env.MCODE_OMP_STATUS_EXTENSION
  const savedPrimeAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR
  const savedMCodePrimeAgentSourceDir = process.env.MCODE_PRIME_AGENT_SOURCE_AGENT_DIR
  const savedMCodePrimeAgentStatusExtension = process.env.MCODE_PRIME_AGENT_STATUS_EXTENSION
  const savedMCodeClaudeAgentStatusSettings = process.env.MCODE_CLAUDE_AGENT_STATUS_SETTINGS
  const savedProcessPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const savedDisableMacosLoginShell = process.env.MCODE_DISABLE_MACOS_LOGIN_SHELL
  const savedMCodeUserDataPath = process.env.MCODE_USER_DATA_PATH

  function applyTestEnvDefaults() {
    // Why: most PTY spawn tests assert POSIX shell behavior; Windows cases opt into win32 explicitly below.
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin'
    })
    // Why: forced darwin makes the TCC login(1) wrapper rewrite every asserted argv; its own test below re-enables it.
    process.env.MCODE_DISABLE_MACOS_LOGIN_SHELL = '1'
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.MCODE_OPENCODE_SOURCE_CONFIG_DIR
    delete process.env.MCODE_OPENCODE_CONFIG_DIR
    delete process.env.MCODE_AGENT_HOOK_ENDPOINT
    delete process.env.MCODE_CLAUDE_AGENT_STATUS_SETTINGS
    delete process.env.PI_CODING_AGENT_DIR
    delete process.env.MCODE_PI_SOURCE_AGENT_DIR
    delete process.env.MCODE_PI_CODING_AGENT_DIR
    delete process.env.MCODE_CODEX_HOME
    delete process.env.MCODE_OMP_SOURCE_AGENT_DIR
    delete process.env.MCODE_OMP_CODING_AGENT_DIR
    delete process.env.MCODE_OMP_STATUS_EXTENSION
    delete process.env.PRIME_AGENT_CODING_AGENT_DIR
    delete process.env.MCODE_PRIME_AGENT_SOURCE_AGENT_DIR
    delete process.env.MCODE_PRIME_AGENT_STATUS_EXTENSION
  }

  function restoreProcessEnv() {
    if (savedProcessPlatform) {
      Object.defineProperty(process, 'platform', savedProcessPlatform)
    }
    if (savedDisableMacosLoginShell !== undefined) {
      process.env.MCODE_DISABLE_MACOS_LOGIN_SHELL = savedDisableMacosLoginShell
    } else {
      delete process.env.MCODE_DISABLE_MACOS_LOGIN_SHELL
    }
    if (savedMCodeUserDataPath !== undefined) {
      process.env.MCODE_USER_DATA_PATH = savedMCodeUserDataPath
    } else {
      delete process.env.MCODE_USER_DATA_PATH
    }
    if (savedOpenCodeConfigDir !== undefined) {
      process.env.OPENCODE_CONFIG_DIR = savedOpenCodeConfigDir
    } else {
      delete process.env.OPENCODE_CONFIG_DIR
    }
    if (savedMCodeOpenCodeConfigDir !== undefined) {
      process.env.MCODE_OPENCODE_CONFIG_DIR = savedMCodeOpenCodeConfigDir
    } else {
      delete process.env.MCODE_OPENCODE_CONFIG_DIR
    }
    if (savedMCodeOpenCodeSourceConfigDir !== undefined) {
      process.env.MCODE_OPENCODE_SOURCE_CONFIG_DIR = savedMCodeOpenCodeSourceConfigDir
    } else {
      delete process.env.MCODE_OPENCODE_SOURCE_CONFIG_DIR
    }
    if (savedPiAgentDir !== undefined) {
      process.env.PI_CODING_AGENT_DIR = savedPiAgentDir
    } else {
      delete process.env.PI_CODING_AGENT_DIR
    }
    if (savedMCodePiAgentDir !== undefined) {
      process.env.MCODE_PI_CODING_AGENT_DIR = savedMCodePiAgentDir
    } else {
      delete process.env.MCODE_PI_CODING_AGENT_DIR
    }
    if (savedMCodePiSourceAgentDir === undefined) {
      delete process.env.MCODE_PI_SOURCE_AGENT_DIR
    } else {
      process.env.MCODE_PI_SOURCE_AGENT_DIR = savedMCodePiSourceAgentDir
    }
    if (savedMCodeCodexHome === undefined) {
      delete process.env.MCODE_CODEX_HOME
    } else {
      process.env.MCODE_CODEX_HOME = savedMCodeCodexHome
    }
    if (savedMCodeOmpAgentDir !== undefined) {
      process.env.MCODE_OMP_CODING_AGENT_DIR = savedMCodeOmpAgentDir
    } else {
      delete process.env.MCODE_OMP_CODING_AGENT_DIR
    }
    if (savedMCodeOmpSourceAgentDir !== undefined) {
      process.env.MCODE_OMP_SOURCE_AGENT_DIR = savedMCodeOmpSourceAgentDir
    } else {
      delete process.env.MCODE_OMP_SOURCE_AGENT_DIR
    }
    if (savedMCodeOmpStatusExtension !== undefined) {
      process.env.MCODE_OMP_STATUS_EXTENSION = savedMCodeOmpStatusExtension
    } else {
      delete process.env.MCODE_OMP_STATUS_EXTENSION
    }
    if (savedPrimeAgentDir !== undefined) {
      process.env.PRIME_AGENT_CODING_AGENT_DIR = savedPrimeAgentDir
    } else {
      delete process.env.PRIME_AGENT_CODING_AGENT_DIR
    }
    if (savedMCodePrimeAgentSourceDir !== undefined) {
      process.env.MCODE_PRIME_AGENT_SOURCE_AGENT_DIR = savedMCodePrimeAgentSourceDir
    } else {
      delete process.env.MCODE_PRIME_AGENT_SOURCE_AGENT_DIR
    }
    if (savedMCodePrimeAgentStatusExtension !== undefined) {
      process.env.MCODE_PRIME_AGENT_STATUS_EXTENSION = savedMCodePrimeAgentStatusExtension
    } else {
      delete process.env.MCODE_PRIME_AGENT_STATUS_EXTENSION
    }
    if (savedMCodeClaudeAgentStatusSettings === undefined) {
      delete process.env.MCODE_CLAUDE_AGENT_STATUS_SETTINGS
    } else {
      process.env.MCODE_CLAUDE_AGENT_STATUS_SETTINGS = savedMCodeClaudeAgentStatusSettings
    }
  }

  return { applyTestEnvDefaults, restoreProcessEnv }
}
