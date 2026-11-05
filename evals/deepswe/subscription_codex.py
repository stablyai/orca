from pier.agents.installed.codex import Codex
from pier.models.agent.network import NetworkAllowlist

# ChatGPT-plan Codex talks to chatgpt.com (inference) and auth.openai.com (token refresh).
SUBSCRIPTION_DOMAINS = ["chatgpt.com", "auth.openai.com"]


class SubscriptionCodex(Codex):
    def network_allowlist(self) -> NetworkAllowlist:
        base = super().network_allowlist().domains
        return NetworkAllowlist(domains=sorted(set(base) | set(SUBSCRIPTION_DOMAINS)))
