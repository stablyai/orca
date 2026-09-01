export const TERMINAL_HTML_FRAGMENT_10 = `          updateTransform();
        }

        var deltaY = ts.lastY - y;
        ts.lastTime = now;
        if (shouldRouteScrollToTerminalInput()) {
          updateTouchVelocity(deltaY, dt);
          resetSmoothScrollOffset();
          var effectiveCellH = getCellHeight() * getTotalScale();
          ts.accumDelta += deltaY;
          var lines = Math.trunc(ts.accumDelta / effectiveCellH);
          if (lines !== 0) {
            ts.accumDelta -= lines * effectiveCellH;
            routeScrollLines(lines, x, y);
          }
        } else {
          if (enqueueNormalBufferScrollDelta(deltaY)) {
            updateTouchVelocity(deltaY, dt);
          } else {
            ts.velY = 0;
          }
        }
        ts.lastX = x;
        ts.lastY = y;
      }
    }, { capture: true, passive: false });

    targetSurface.addEventListener('touchend', function(e) {
      if (dispatcherShouldBlockSurface()) return;
      if (!term) return;

      if (ts.isPinching && e.touches.length < 2) {
        ts.isPinching = false;
        // Why: a finished pinch snaps to the nearest preset and becomes the new
        // font size (reflowing the grid), so pinch-to-zoom IS the in-terminal way
        // to set the text size. The CSS pinch zoom (userScale) is reset; the real
        // size change reflows columns and RN persists + resizes the PTY to match.
        var target = snapToTextScalePreset(currentTextScale * userScale);
        var changed = target !== currentTextScale;
        userScale = 1;
        panX = 0; panY = 0;
        applyTextScale(target);
        updateTransform();
        notify({ type: 'font-scale-changed', fontScale: target });
        if (changed) notify({ type: 'haptic', kind: 'selection' });
        if (e.touches.length === 1) {
          ts.lastX = e.touches[0].clientX;
          ts.lastY = e.touches[0].clientY;
          ts.lastTime = Date.now();
          ts.velY = 0;
          ts.accumDelta = 0;
        }
        return;
      }

      if (e.touches.length === 0) {
        var vel = ts.velY;
        var FRICTION = 0.972;
        var MIN_VEL = 0.012;
        function momentumStep() {
          vel *= FRICTION;
          if (Math.abs(vel) < MIN_VEL) { ts.momentumId = null; return; }
          var delta = vel * 16;
          if (shouldRouteScrollToTerminalInput()) {
            resetSmoothScrollOffset();
            var effectiveCellH = getCellHeight() * getTotalScale();
            ts.accumDelta += delta;
            var lines = Math.trunc(ts.accumDelta / effectiveCellH);
            if (lines !== 0) {
              ts.accumDelta -= lines * effectiveCellH;
              routeScrollLines(lines, ts.lastX, ts.lastY);
            }
          } else {
            if (!applyNormalBufferScrollDelta(delta)) {
              ts.momentumId = null;
              return;
            }
          }
          ts.momentumId = requestAnimationFrame(momentumStep);
        }
        if (Math.abs(vel) > MIN_VEL) {
          ts.momentumId = requestAnimationFrame(momentumStep);
        }
      }
    }, { capture: true, passive: true });
  }

  attachSurfaceEventHandlers(surface);

  function handleIncomingMessage(e) {
    var msg;
    try {
      msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    } catch (ex) {
      return;
    }
    try {
      handleMsg(msg);
    } catch(ex) {
      reportEngineError(
        msg && msg.type === 'init' ? 'terminal init failed' : 'terminal message failed',
        ex,
        msg && msg.type === 'init' && !everReady
      );
    }
  }

  window.addEventListener('message', handleIncomingMessage);

  document.addEventListener('message', handleIncomingMessage);

  window.addEventListener('resize', function() {
    // Why: viewport changed (keyboard open/close, orientation, RN container
    // size update). Re-fit so the scale matches the new vpWidth — without
    // this, opening the keyboard leaves the terminal at the old scale even
    // though there's now less vertical room and the fit ratio may differ.
    applyFitScale('window-resize');
    adjustRowsForViewport();
    repositionOverlay();
    clampPan();
    updateTransform();
  });

  if (window.Terminal) {
    notify({ type: 'web-ready' });
  } else {
    reportEngineError('terminal engine missing', 'xterm failed to load', true);
  }
})();
</script>
</body>
</html>`
