// Built from src/panel.tsx by build.mjs.

// examples/plugins/hello-components/src/panel.tsx
import {
  atom,
  Badge,
  Button,
  derived,
  EmptyState,
  Heading,
  IconButton,
  Input,
  List,
  ListItem,
  on,
  read,
  Row,
  set,
  Stack,
  Switch,
  Text,
  update
} from "orca";
import { jsx, jsxs } from "orca/jsx-runtime";
var todos = atom(
  "todos",
  [
    { id: 1, title: "Read the components guide", done: true },
    { id: 2, title: "Build a panel", done: false }
  ],
  { persist: "plugin" }
);
var hideDone = atom("hide-done", false, { persist: "plugin" });
var draft = atom("");
var open = derived(() => read(todos).filter((todo) => !todo.done).length);
function add() {
  const title = read(draft).trim();
  if (!title) {
    return;
  }
  update(todos, (list) => [
    ...list,
    { id: Math.max(0, ...list.map((t) => t.id)) + 1, title, done: false }
  ]);
  set(draft, "");
}
function toggle(id) {
  update(
    todos,
    (list) => list.map((todo) => todo.id === id ? { ...todo, done: !todo.done } : todo)
  );
}
function TodoList({ items }) {
  if (items.length === 0) {
    return /* @__PURE__ */ jsx(EmptyState, { icon: "check", title: "Nothing to do", description: "Add a task above." });
  }
  return /* @__PURE__ */ jsx(List, { label: "Tasks", children: items.map((todo) => /* @__PURE__ */ jsx(
    ListItem,
    {
      icon: todo.done ? "check" : "stop",
      title: todo.title,
      description: todo.done ? "Done" : "Open",
      onPress: () => toggle(todo.id)
    },
    String(todo.id)
  )) });
}
var seenThemes = atom(0);
function setup(ctx) {
  ctx.subscriptions.push(on("theme", () => update(seenThemes, (n) => n + 1)));
}
function Panel() {
  const all = read(todos);
  const items = read(hideDone) ? all.filter((todo) => !todo.done) : all;
  const count = read(open);
  return /* @__PURE__ */ jsxs(Stack, { gap: "md", children: [
    /* @__PURE__ */ jsxs(Row, { justify: "between", children: [
      /* @__PURE__ */ jsx(Heading, { children: "Tasks" }),
      /* @__PURE__ */ jsxs(Badge, { tone: count > 0 ? "accent" : "neutral", children: [
        count,
        " open"
      ] })
    ] }),
    /* @__PURE__ */ jsxs(Row, { gap: "xs", children: [
      /* @__PURE__ */ jsx(
        Input,
        {
          label: "New task",
          labelHidden: true,
          placeholder: "New task",
          value: read(draft),
          onChange: (value) => set(draft, value),
          onSubmit: add
        }
      ),
      /* @__PURE__ */ jsx(IconButton, { icon: "add", label: "Add task", onPress: add, disabled: !read(draft).trim() })
    ] }),
    /* @__PURE__ */ jsx(
      Switch,
      {
        label: "Hide done",
        checked: read(hideDone),
        onChange: (value) => set(hideDone, value)
      }
    ),
    /* @__PURE__ */ jsx(TodoList, { items }),
    /* @__PURE__ */ jsx(Row, { justify: "end", children: /* @__PURE__ */ jsx(
      Button,
      {
        variant: "ghost",
        onPress: () => update(todos, (list) => list.filter((todo) => !todo.done)),
        children: "Clear done"
      }
    ) }),
    /* @__PURE__ */ jsxs(Text, { muted: true, size: "xs", children: [
      "Runs isolated with no network; Orca draws every control. Theme changes seen:",
      " ",
      read(seenThemes),
      "."
    ] })
  ] });
}
export {
  Panel as default,
  setup
};
