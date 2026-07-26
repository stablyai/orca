export const TERMINAL_SCROLL_COORDINATOR_JS = String.raw`
function createTerminalScrollCoordinator(adapter) {
  var state = {
    generation: 0,
    intent: 'following-output',
    distanceFromBottom: 0
  };
  var pendingViewportTransition = null;
  var pendingOutputViewportY = null;
  var pixelRemainder = 0;
  var phase = 'replaying';

  function readNormalMetrics() {
    var metrics = adapter.readMetrics();
    return metrics && metrics.bufferMode === 'normal' ? metrics : null;
  }

  function syncIntentFromMetrics(metrics) {
    var distanceFromBottom = Math.max(0, metrics.baseY - metrics.viewportY);
    state.distanceFromBottom = distanceFromBottom;
    state.intent = distanceFromBottom === 0 ? 'following-output' : 'reading-history';
  }

  function syncIntentFromViewport() {
    var metrics = readNormalMetrics();
    if (metrics) syncIntentFromMetrics(metrics);
  }

  function updateHistoryDistance() {
    var metrics = readNormalMetrics();
    if (!metrics || state.intent !== 'reading-history') return;
    state.distanceFromBottom = Math.max(0, metrics.baseY - metrics.viewportY);
  }

  function restoreIntent() {
    var metrics = readNormalMetrics();
    if (!metrics) return;
    if (state.intent === 'following-output') {
      adapter.scrollToBottom();
      state.distanceFromBottom = 0;
      return;
    }
    adapter.scrollToLine(Math.max(0, metrics.baseY - state.distanceFromBottom));
    syncIntentFromViewport();
  }

  function scrollLines(lines, clientX, clientY) {
    if (lines === 0) return false;
    if (adapter.shouldRouteToTerminalInput()) {
      adapter.routeTerminalInput(lines, clientX, clientY);
      return true;
    }
    var before = readNormalMetrics();
    if (!before) return false;
    const clamped = lines > 0
      ? Math.min(lines, Math.max(0, before.baseY - before.viewportY))
      : Math.max(lines, -before.viewportY);
    if (clamped === 0) {
      pixelRemainder = 0;
      return false;
    }
    adapter.scrollLines(clamped);
    var after = readNormalMetrics();
    if (after) {
      syncIntentFromMetrics(after);
      if (pendingViewportTransition) {
        pendingViewportTransition.intent = state.intent;
      }
      if (pendingOutputViewportY !== null) pendingOutputViewportY = after.viewportY;
    }
    adapter.revealIndicator();
    return true;
  }

  function dispatch(event) {
    if (event.type === 'begin-generation') {
      var previousMetrics = event.preserveScroll ? readNormalMetrics() : null;
      var preserveHistory = event.preserveScroll && (
        state.generation === 0
          ? Boolean(previousMetrics && previousMetrics.baseY - previousMetrics.viewportY > 0)
          : state.intent === 'reading-history'
      );
      var previous = preserveHistory ? previousMetrics : null;
      var distanceFromBottom = previous
        ? Math.max(0, previous.baseY - previous.viewportY)
        : preserveHistory ? state.distanceFromBottom : 0;
      state.generation = event.generation;
      state.intent = preserveHistory ? 'reading-history' : 'following-output';
      state.distanceFromBottom = distanceFromBottom;
      pendingViewportTransition = null;
      pendingOutputViewportY = null;
      pixelRemainder = 0;
      phase = 'replaying';
      return true;
    }
    if (event.generation !== state.generation) return false;
    if (event.type === 'replay-committed') {
      phase = 'live';
      restoreIntent();
      return true;
    }
    if (event.type === 'output-started') {
      var metrics = readNormalMetrics();
      pendingOutputViewportY =
        phase === 'live' && state.intent === 'reading-history' && metrics
          ? metrics.viewportY
          : null;
      return true;
    }
    if (event.type === 'output-committed') {
      if (phase === 'replaying') return true;
      if (pendingViewportTransition) {
        pendingOutputViewportY = null;
        return true;
      }
      if (state.intent === 'following-output' && readNormalMetrics()) {
        adapter.scrollToBottom();
      } else if (pendingOutputViewportY !== null && readNormalMetrics()) {
        adapter.scrollToLine(pendingOutputViewportY);
      }
      pendingOutputViewportY = null;
      updateHistoryDistance();
      return true;
    }
    if (event.type === 'user-scroll-lines') return scrollLines(event.lines);
    if (event.type === 'user-scroll-pixels') {
      if (event.deltaY === 0 || event.pixelsPerLine <= 0) return false;
      pixelRemainder += event.deltaY;
      const lines = Math.trunc(pixelRemainder / event.pixelsPerLine);
      if (lines === 0) return true;
      var handled = scrollLines(lines, event.clientX, event.clientY);
      pixelRemainder = handled ? pixelRemainder - lines * event.pixelsPerLine : 0;
      return handled;
    }
    if (event.type === 'reset-gesture') {
      pixelRemainder = 0;
      return true;
    }
    if (event.type === 'jump-to-bottom') {
      state.intent = 'following-output';
      state.distanceFromBottom = 0;
      if (pendingViewportTransition) {
        pendingViewportTransition.intent = 'following-output';
      }
      pendingOutputViewportY = null;
      pixelRemainder = 0;
      if (readNormalMetrics()) adapter.scrollToBottom();
      return true;
    }
    if (event.type === 'viewport-change') {
      updateHistoryDistance();
      pendingViewportTransition = {
        intent: state.intent
      };
      pendingOutputViewportY = null;
      adapter.changeViewport(event.change);
      return true;
    }
    if (event.type === 'viewport-committed') {
      var transition = pendingViewportTransition;
      if (!transition) return false;
      pendingViewportTransition = null;
      state.intent = transition.intent;
      if (state.intent === 'following-output') {
        var metrics = readNormalMetrics();
        state.distanceFromBottom = 0;
        if (metrics && metrics.viewportY < metrics.baseY) adapter.scrollToBottom();
        return true;
      }
      restoreIntent();
      return true;
    }
    return false;
  }

  return {
    dispatch: dispatch,
    getState: function() {
      return {
        generation: state.generation,
        intent: state.intent,
        distanceFromBottom: state.distanceFromBottom
      };
    }
  };
}
`
