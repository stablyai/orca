"""Task definitions and independently observed benchmark verdicts. No desktop imports."""
import random
import re
import statistics

MARKER = "Orca café Ω"
DECOY = "untouched"
SELECTORS = {
    "field": (r"\b(edit|text|entry|textbox)\b", r"\bfield\b"),
    "button": (r"\b(button|push button)\b", r"\bincrement\b"),
    "color": (r"combo|popup|list ?box|menu ?button", r"\bcolor\b"),
    "scroll": (r"list|scroll|document|web", r"\blist\b|\bbenchelectron\b"),
}
TASKS = {
    "targeted_type": [("type", "field")],
    "type_submit": [("click", "field"), ("type", "field"), ("return", "field")],
    "replace_submit": [("click", "field"), ("ctrl_a", "field"), ("type", "field"), ("return", "field")],
    "choose_and_click": [("choose", "color"), ("click", "button")],
    "click_interference": [("click", "button")],
    "scroll_interference": [("scroll", "scroll")],
}
ROLE_KEYS = ("role", "control_type", "role_description", "localized_role", "subrole", "controlType", "localizedControlType")
LABEL_KEYS = ("label", "name", "title", "description", "automation_id", "automationId", "help", "placeholder")


class DiscoveryError(Exception):
    pass


def select_unique(elements, selector):
    role, label = selector
    matches = [element for element in elements
               if re.search(role, " ".join(str(element.get(key) or "") for key in ROLE_KEYS), re.I)
               and any(re.search(label, str(element.get(key) or ""), re.I) for key in LABEL_KEYS)]
    if len(matches) != 1:
        raise DiscoveryError(f"selector {selector!r} matched {len(matches)} elements")
    return matches[0]


def initial_state(task):
    text = "hello" if task == "replace_submit" else ""
    return {"text": text, "decoyText": DECOY, "count": 0, "returns": 0, "combo": "Red", "top": 0,
            "submittedText": None, "clickedColor": None,
            "check": False, "menuHits": 0, "dropOpen": False, "selStart": len(text), "selLen": 0,
            "logicalFocus": "decoy" if task == "targeted_type" else "field"}


def acknowledged(state, instance, pid, nonce):
    return (state.get("instance") == instance and state.get("pid") == pid
            and state.get("ack") == nonce)


def prepared(state, task, instance, pid, nonce):
    return acknowledged(state, instance, pid, nonce) and all(
        key in state and state[key] == value for key, value in initial_state(task).items())


def completed(state, task):
    expected = initial_state(task)
    for key in ("selStart", "selLen", "logicalFocus", "submittedText", "clickedColor"):
        del expected[key]
    if task in ("targeted_type", "type_submit", "replace_submit"):
        expected["text"] = MARKER
    if task in ("type_submit", "replace_submit"):
        expected["returns"] = 1
        expected["submittedText"] = MARKER
    if task in ("choose_and_click", "click_interference"):
        expected["count"] = 1
    if task == "choose_and_click":
        expected["combo"] = "Blue"
        expected["clickedColor"] = "Blue"
    if task == "scroll_interference":
        del expected["top"]
        if not isinstance(state.get("top"), (int, float)) or state["top"] <= 0:
            return False
    return all(state.get(key) == value for key, value in expected.items())


def verdict(row, state):
    if not row.get("prepared"):
        return "invalid_setup"
    if state is None:
        return "unobserved"
    return "completed" if completed(state, row["task"]) else "failed"


def schedule(engines, tasks, rounds, seed):
    rng = random.Random(seed)
    order = list(engines)
    rng.shuffle(order)
    cells = []
    for round_index in range(rounds):
        task_order = list(tasks)
        rng.shuffle(task_order)
        for task in task_order:
            for index in range(len(order)):
                cells.append({"engine": order[(index + round_index) % len(order)],
                              "task": task, "round": round_index})
    return cells


def summarize(rows):
    groups = {}
    for row in rows:
        groups.setdefault((row["engine"], row["task"], row["profile"]), []).append(row)
    summary = []
    for (engine, task, profile), group in sorted(groups.items()):
        valid = [row for row in group if row["verdict"] != "invalid_setup"]
        successful = [row for row in valid if row["verdict"] == "completed"]
        times = [row["attempt_ms"] for row in successful if row.get("attempt_ms") is not None]
        failures = [row["attempt_ms"] for row in valid if row["verdict"] != "completed" and row.get("attempt_ms") is not None]
        paired = [sample for row in successful for sample in row.get("action_read_ms", [])]
        summary.append({"engine": engine, "task": task, "profile": profile, "planned": len(group),
                        "scored": len(valid), "invalid": len(group) - len(valid),
                        "completed": sum(row["verdict"] == "completed" for row in valid),
                        "unobserved": sum(row["verdict"] == "unobserved" for row in valid),
                        "api_errors": sum(bool(row.get("api_errors")) for row in valid),
                        **{key: sum(row.get(key, 0) for row in valid) for key in
                           ("keys_sent", "keys_received", "keys_lost", "agent_text_in_sentinel", "target_q_characters")},
                        "discovery_failures": sum(bool(row.get("discovery_error")) for row in valid),
                        "task_ms": round(statistics.median(times), 1) if times else None,
                        "failed_attempt_ms": round(statistics.median(failures), 1) if failures else None,
                        "timed_completions": len(times), "timed_failures": len(failures),
                        "action_read_ms": round(statistics.median(paired), 1) if paired else None,
                        **{key: sum(bool(row.get("observation", {}).get(key)) for row in valid)
                           for key in ("sentinel_lost_focus", "target_raised", "pointer_moved", "clipboard_changed")}})
    return summary
