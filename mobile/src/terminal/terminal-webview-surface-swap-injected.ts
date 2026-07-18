export const TERMINAL_SURFACE_SWAP_JS = String.raw`
  // Why: phone-fit startup can issue several init() calls before xterm finishes
  // replaying. Track the last painted surface separately from its replacement.
  var committedTerm = null;
  var committedSurface = surface;
  var pendingTerm = null;
  var pendingSurface = null;

  function beginTerminalSurfaceSwap() {
    // Why: a superseded hidden replacement must not remain between the last
    // painted surface and the newest one, or the newest commits below the viewport.
    if (pendingSurface) {
      try { pendingSurface.remove(); } catch (e) {}
      if (pendingTerm) try { pendingTerm.dispose(); } catch (e) {}
      pendingSurface = null;
      pendingTerm = null;
    }
    var swap = {
      oldTerm: committedTerm,
      oldSurface: committedSurface,
      nextSurface: document.createElement('div')
    };
    disposeTermObservers();
    swap.nextSurface.id = 'terminal-surface';
    swap.nextSurface.style.visibility = 'hidden';
    swap.nextSurface.style.position = 'absolute';
    swap.nextSurface.style.left = '0';
    swap.nextSurface.style.top = '0';
    document.getElementById('terminal-container').appendChild(swap.nextSurface);
    surface = swap.nextSurface;
    pendingSurface = swap.nextSurface;
    attachSurfaceEventHandlers(surface);
    swap.oldSurface.removeAttribute('id');
    return swap;
  }

  function commitTerminalSurfaceSwap(swap, nextTerm) {
    swap.nextSurface.style.visibility = 'visible';
    swap.nextSurface.style.position = '';
    swap.nextSurface.style.left = '';
    swap.nextSurface.style.top = '';
    swap.oldSurface.remove();
    if (swap.oldTerm) swap.oldTerm.dispose();
    committedTerm = nextTerm;
    committedSurface = swap.nextSurface;
    pendingTerm = null;
    pendingSurface = null;
  }
`
