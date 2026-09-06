# Chrome DevTools coverage across the Orca agent catalog

Catalog and upstream documentation audited on September 5, 2026. The
[Orca agent catalog](../../src/shared/tui-agent-config.ts) contains **36 agent IDs**.

Orca provides [native configuration](chrome-devtools-mcp.md) for **Codex, OpenCode
v1, Gemini, and Pi**. `orca agent chrome-devtools setup --agent all` means these
four targets, with every prerequisite checked before writing any config.

The [Chrome DevTools CLI bridge](chrome-devtools-bridge.md) provides a common route
for the remaining catalog agents when their shell facility and user policies
permit local command execution. Aider, for example, can use `/run orca
chrome-devtools call --tool list_pages --json` and its normal confirmation flow to
add results to the conversation. This does not add native MCP support to Aider or
bypass a harness's execution approvals.

The table distinguishes an Orca implementation route from an upstream client's
MCP capability. Only the four native setup targets have config writers in this
contribution. The other native-capable clients can be configured manually using
their official documentation, or use the CLI bridge through their shell tool.

## Validation limits

The development environment contained Codex, OpenCode, Pi, Gemini, and Aider.
The other **31 clients were not installed and were not tested live**. Documentation
supports the integration design; it is not evidence that every catalog client
loaded native MCP tools or executed a browser operation.

Configuration, MCP discovery, and a callable browser connection are separate
checks. See the [native setup verification guidance](chrome-devtools-mcp.md#execution-host-and-verification)
and [bridge verification commands](chrome-devtools-bridge.md#discover-and-call-tools).

## Status vocabulary

- **native-capable**: upstream client supports local MCP, with caveats below. Does not mean configured, installed, or verified locally.
- **adapter-required**: MCP is provided by a separate compatible extension.
- **bridge-required**: no native MCP client support verified; CLI bridge is the chosen route.
- **runtime-unknown**: registry/config exists but actual exposure depends on runtime/version.

## Catalog matrix

Paths below describe upstream current defaults on Unix-like hosts; env overrides, profiles, Windows paths and legacy versions must be resolved before writes. `mcpServers` means map unless an array is specified.

| Orca ID            | Orca route   | Upstream capability               | Global mechanism / caveat                                                                                                                             | Official source                                                                                                                                                    |
| ------------------ | ------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| claude             | CLI bridge   | native-capable                    | `claude mcp add --scope user`; `~/.claude.json`, `mcpServers`                                                                                         | [Chrome guide](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/client-configurations.md)                                                      |
| claude-agent-teams | CLI bridge   | native-capable                    | Same Claude process/config; Orca wrapper requires Claude                                                                                              | [Orca catalog](../../src/shared/tui-agent-config.ts)                                                                                                               |
| openclaude         | CLI bridge   | native-capable                    | `openclaude mcp add --scope user`; current `~/.openclaude.json`, not assumed shared Claude config                                                     | [CLI](https://github.com/gitlawb/openclaude/blob/main/src/commands/mcp/addCommand.ts), [path](https://github.com/gitlawb/openclaude/blob/main/src/utils/config.ts) |
| codex              | Native setup | native-capable                    | Canonical `~/.codex/config.toml`, `mcp_servers`; Orca mirrors into managed account homes                                                              | [Orca native setup](chrome-devtools-mcp.md)                                                                                                                        |
| autohand           | CLI bridge   | native-capable                    | `~/.autohand/config.{toml,yaml,yml,json}`; `mcp.servers` array, name/transport/command/args; mcp.enabled                                              | [Reference](https://github.com/autohandai/code-cli/blob/main/docs/config-reference.md)                                                                             |
| ante               | CLI bridge   | native-capable                    | `~/.ante/settings.json`, `mcp_servers` map, stdio only                                                                                                | [MCP](https://ante.run/extend/mcp/)                                                                                                                                |
| trae               | CLI bridge   | native-capable                    | v2 `~/.trae/traecli.toml`, `[mcp_servers.name]`; published v1 YAML differs                                                                            | [v2 config](https://docs.trae.cn/cli_config-file), [v2 start](https://docs.trae.cn/cli_get-started-with-trae-code-cli-2)                                           |
| opencode           | Native setup | native-capable                    | v1 `~/.config/opencode/opencode.json[c]`, mcp map, type local, command array; v2 differs                                                              | [MCP](https://opencode.ai/docs/mcp-servers/)                                                                                                                       |
| mimo-code          | CLI bridge   | native-capable                    | `~/.config/mimocode/mimocode.json[c]`, mcp map/type local/command array; MIMOCODE_HOME changes paths                                                  | [README](https://github.com/XiaomiMiMo/MiMo-Code), [MCP](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/web/src/content/docs/mcp-servers.mdx)          |
| pi                 | Native setup | adapter-required                  | Compatible pi-mcp-adapter; Pi agent-dir/mcp.json override, mcpServers. Current adapter also reads shared MCP configs; host imports explicit           | [Adapter](https://github.com/nicobailon/pi-mcp-adapter)                                                                                                            |
| omp                | CLI bridge   | native-capable                    | `~/.omp/agent/mcp.json`, mcpServers; named profiles have separate agent directories; disabledServers can suppress                                     | [MCP](https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md)                                                                                            |
| prime-agent        | CLI bridge   | native-capable                    | `prime-agent mcp add name -- command args`; `~/.prime/agent/settings.json`, mcpServers; callable via Python kernel mcp.call_tool                      | [MCP](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/mcp-integrations.md)                                                   |
| gemini             | Native setup | native-capable                    | `gemini mcp add -s user`; ~/.gemini/settings.json, mcpServers; system policy may restrict                                                             | [Chrome guide](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/client-configurations.md)                                                      |
| antigravity        | CLI bridge   | native-capable                    | Current CLI `~/.gemini/config/mcp_config.json`, mcpServers/command/args; differs from old IDE paths                                                   | [CLI MCP](https://antigravity.google/docs/cli/mcp)                                                                                                                 |
| aider              | CLI bridge   | bridge-required                   | No MCP client config verified. `/run` and suggested shell commands can invoke Orca bridge with normal execution/output confirmations                  | [Open request](https://github.com/Aider-AI/aider/issues/3314), [args](https://github.com/Aider-AI/aider/blob/main/aider/args.py); Aider 0.86 shell command support |
| goose              | CLI bridge   | native-capable                    | `~/.config/goose/config.yaml`, extensions map: name/cmd/args/type stdio/enabled/envs                                                                  | [Config](https://github.com/aaif-goose/goose/blob/main/documentation/docs/getting-started/using-extensions.md)                                                     |
| amp                | CLI bridge   | native-capable                    | `amp mcp add name -- command args`; `~/.config/amp/settings.json`, literal key amp.mcpServers; cloud Orbs separate                                    | [MCP](https://ampcode.com/docs/customize/mcp)                                                                                                                      |
| kilo               | CLI bridge   | native-capable                    | `~/.config/kilo/kilo.json[c]`, mcp map/type local/command array                                                                                       | [MCP](https://kilo.ai/docs/automate/mcp/using-in-kilo-code)                                                                                                        |
| kiro               | CLI bridge   | native-capable                    | `~/.kiro/settings/mcp.json`, mcpServers; agent includeMcpJson and overrides affect inheritance                                                        | [Scopes](https://kiro.dev/docs/cli/chat/configuration/), [MCP](https://kiro.dev/docs/mcp/configuration/)                                                           |
| crush              | CLI bridge   | native-capable, version-sensitive | Current main documents `~/.config/crush/crushrc`, DSL mcp add; JSON examples remain. Resolve installed version before choosing writer                 | [README](https://github.com/charmbracelet/crush)                                                                                                                   |
| aug                | CLI bridge   | native-capable                    | `auggie mcp add-json`; `~/.augment/settings.json`                                                                                                     | [MCP](https://docs.augmentcode.com/cli/integrations)                                                                                                               |
| cline              | CLI bridge   | native-capable, version-sensitive | Current docs `~/.cline/mcp.json`; older CLI data/settings/cline_mcp_settings.json. Use installed CLI/path resolver                                    | [MCP](https://docs.cline.bot/mcp/mcp-overview), [CLI](https://docs.cline.bot/cli/cli-reference)                                                                    |
| codebuff           | CLI bridge   | native-capable                    | Official SDK reads `~/.agents/mcp.json`, cwd/.agents and parent/.agents; mcpServers. Verify binary/version loader                                     | [Loader](https://github.com/CodebuffAI/codebuff/blob/main/sdk/src/agents/load-mcp-config.ts)                                                                       |
| command-code       | CLI bridge   | native-capable                    | `command-code mcp add --scope user`; ~/.commandcode/mcp.json, mcpServers/transport stdio                                                              | [MCP](https://commandcode.ai/docs/mcp)                                                                                                                             |
| continue           | CLI bridge   | native-capable                    | ~/.continue/config.yaml, mcpServers array; selected saved config or --config may replace default                                                      | [CLI](https://docs.continue.dev/cli/configuration), [schema](https://docs.continue.dev/reference)                                                                  |
| cursor             | CLI bridge   | native-capable                    | CLI shares IDE MCP config, ~/.cursor/mcp.json, mcpServers                                                                                             | [CLI](https://docs.cursor.com/en/cli/using), [MCP](https://prod.cursor.com/help/customization/mcp)                                                                 |
| droid              | CLI bridge   | native-capable                    | droid mcp add writes ~/.factory/mcp.json, mcpServers; subagent selection/org policy can restrict                                                      | [MCP](https://docs.factory.ai/harness/mcp)                                                                                                                         |
| kimi               | CLI bridge   | native-capable, version-sensitive | Current ~/.kimi-code/mcp.json or KIMI_CODE_HOME/mcp.json, mcpServers; older paths differ                                                              | [MCP](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html)                                                                                      |
| mistral-vibe       | CLI bridge   | native-capable                    | ~/.vibe/config.toml, [[mcp_servers]] array, name/transport stdio/command/args                                                                         | [MCP](https://docs.mistral.ai/vibe/code/cli/mcp-servers), [path](https://docs.mistral.ai/resources/mcp)                                                            |
| qwen-code          | CLI bridge   | native-capable                    | ~/.qwen/settings.json, mcpServers; system policy wins                                                                                                 | [Settings](https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/settings.md)                                                                     |
| rovo               | CLI bridge   | native-capable, identity check    | Rovo Dev ~/.rovodev/mcp.json, mcpServers/transport stdio; config.yml may change path. Verify `rovo` identifies Rovo Dev                               | [Atlassian](https://support.atlassian.com/rovo/docs/connect-to-an-mcp-server-in-rovo-dev-cli/)                                                                     |
| hermes             | CLI bridge   | native-capable                    | ~/.hermes/config.yaml, mcp_servers map; profiles/filters can change effective configuration                                                           | [MCP](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/mcp-config-reference.md)                                                       |
| openclaw           | CLI bridge   | runtime-unknown                   | Current outbound registry `openclaw mcp add --command ... --arg ...`, mcp.servers. Registry entries consumed only by eligible runtimes; not MCP serve | [CLI MCP](https://docs.openclaw.ai/cli/mcp)                                                                                                                        |
| copilot            | CLI bridge   | native-capable                    | ~/.copilot/mcp-config.json, mcpServers/type local, command string+args; tools filter                                                                  | [GitHub](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)                                                                 |
| grok               | CLI bridge   | native-capable                    | grok mcp add name -- command args; ~/.grok/config.toml, mcp_servers; optional Claude/Cursor imports lower priority                                    | [MCP](https://docs.x.ai/build/features/mcp-servers)                                                                                                                |
| devin              | CLI bridge   | native-capable, version-sensitive | devin mcp add -s user; >=3000.3 ~/.config/devin/mcp_config.json, earlier config.json; mcpServers                                                      | [CLI MCP](https://docs.devin.ai/cli/extensibility/mcp/configuration)                                                                                               |

## Operational boundaries

- Resolve each client's installed version, environment overrides, and profiles
  before writing configuration. Fork relationships do not imply identical paths.
- A configured server does not prove MCP discovery or an authorized Chrome
  connection. Verify each layer separately with a nonmutating browser call.
- Shell-based access preserves the harness's normal permissions and confirmations.
  It cannot install an absent client or enable shell execution against user policy.
- Separate bridge `call` invocations start fresh MCP sessions. Use the persistent
  [JSONL session](chrome-devtools-bridge.md#preserve-browser-session-state) for
  selected pages, snapshot UIDs, and other MCP session state.
- `--autoConnect` applies to the host running Chrome MCP. SSH, WSL, and cloud
  runtimes need a separately scoped connection to access Chrome on another host.
