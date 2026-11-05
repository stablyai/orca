"""Claude Code and Codex reduced to one shell tool and a shared minimal prompt (approximating mini-swe-agent)."""
import shlex
from pathlib import Path

from pier.agents.installed.claude_code import ClaudeCode

from subscription_codex import SubscriptionCodex

PROMPT = (Path(__file__).parent / "stripped_system_prompt.md").read_text()
CODEX_PROMPT_PATH = "/tmp/stripped-codex/instructions.md"

CODEX_CONFIG = f"""
model_instructions_file = "{CODEX_PROMPT_PATH}"
web_search = "disabled"
project_doc_max_bytes = 0

[features]
view_image = false
multi_agent = false
apps = false
goals = false
memories = false

[skills.bundled]
enabled = false
"""


class StrippedClaudeCode(ClaudeCode):
    # Pier interpolates str flags unquoted, so multi-word values are added here instead.
    def build_cli_flags(self) -> str:
        extra = ["--tools Bash", "--strict-mcp-config", "--disable-slash-commands",
                 f"--system-prompt {shlex.quote(PROMPT)}"]
        return " ".join([super().build_cli_flags(), *extra]).strip()


class StrippedCodex(SubscriptionCodex):
    def __init__(self, *args, **kwargs):
        kwargs.setdefault("config_toml", CODEX_CONFIG)
        super().__init__(*args, **kwargs)

    # Reuses the setup hook to place the replacement instructions file before codex starts.
    def _build_register_skills_command(self) -> str | None:
        write = (f"mkdir -p {shlex.quote(str(Path(CODEX_PROMPT_PATH).parent))} && "
                 f"printf '%s' {shlex.quote(PROMPT)} > {shlex.quote(CODEX_PROMPT_PATH)}")
        base = super()._build_register_skills_command()
        return f"{write}\n{base}" if base else write
