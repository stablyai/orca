# Bounded companion change — SCL PreTool decision point

**Repo** `scl-platform` · **File** `.codex/hooks/pre_tool_use_policy.py` · **One site: `main()`**

Orca now consumes a PreTool receipt (`orchestration.pretoolReceipt`, CLI
`orca orchestration pretool-receipt`). It does not and must not re-implement the policy.
The only change needed on the SCL side is to report the decision this file already makes.

## Why this exact site

`main()` is the sole place the real verdict exists:

```python
violation = evaluate(payload)      # <- THE decision
if violation:                       # violation is None  -> ALLOW
    print(json.dumps(deny(violation)))   # violation is str -> BLOCK
return 0
```

`evaluate()` is unchanged. No allowlist, pattern, or `deny()` shape is touched.

## The change

```python
def _emit_receipt(decision: str, reason: str | None, payload: dict[str, Any]) -> None:
    """Report the decision just made to Orca. Best effort: never alters the verdict."""
    if not os.environ.get("ORCA_TERMINAL_HANDLE"):
        return                      # not an Orca-supervised session; nothing to report
    tool = payload.get("tool_name")
    args = [
        "orca", "orchestration", "pretool-receipt",
        "--decision", decision,
        "--policy", "scl.pre_tool_use_policy",
        "--policy-version", POLICY_VERSION,
        *(["--tool", str(tool)] if isinstance(tool, str) else []),
        *(["--reason", reason] if reason else []),
        "--json",
    ]
    try:
        subprocess.run(args, capture_output=True, timeout=5, check=False)
    except Exception:
        pass                        # reporting must never change what the policy decided


def main() -> int:
    ...
    violation = evaluate(payload)
    _emit_receipt("block" if violation else "allow", violation, payload)
    if violation:
        print(json.dumps(deny(violation)))
    return 0
```

Plus `import os`, `import subprocess`, and a `POLICY_VERSION` constant.

## What it must not become

- Do not decide anything in the emitter; it reports a verdict already reached.
- Do not let a reporting failure change the verdict — hence best-effort and `check=False`.
- Do not emit on `PostToolUse`, on the parse-failure `deny()` fallback path, or from any
  static/canned hook output. Only the real `evaluate()` result.
- Do not pass Run/Task/Dispatch/route/build. Orca fills those from its own records keyed by
  the attested session; an emitter that could name them could aim a receipt at work it is
  not doing.

## What Orca already guarantees about it

- Unattested caller → `pretool_receipt_unattested`; no receipt.
- Pane with no active Dispatch → `pretool_receipt_unbound`; no receipt.
- Receipt earned under another runtime build → ignored at read time.
- A `block` outranks an `allow` on the same Dispatch.
- Absent a receipt, `pretool_acceptance` fails closed exactly as it does today.
