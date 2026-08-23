export const TERMINAL_VIEWPORT_JS = `
  var rnViewport = null;
  var rnDpr = window.devicePixelRatio || 1;
  var dprMediaQuery = null;

  function getViewportWidth() {
    return rnViewport && rnViewport.width > 0 ? rnViewport.width : window.innerWidth;
  }

  function getViewportHeight() {
    return rnViewport && rnViewport.height > 0 ? rnViewport.height : window.innerHeight;
  }

  function notifyViewportChanged() {
    notify({
      type: 'viewport-changed',
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      dpr: window.devicePixelRatio || 1
    });
  }

  function handleDevicePixelRatioChange() {
    try {
      var renderService = term && term._core && term._core._renderService;
      if (renderService && renderService.handleDevicePixelRatioChange) {
        renderService.handleDevicePixelRatioChange();
      } else if (term) {
        if (webglAddon) {
          try { webglAddon.dispose(); } catch (e) {}
          webglAddon = null;
        }
        attachWebglAddon(true);
      }
    } catch (e) {}
    applyFitScale('dpr');
    notifyViewportChanged();
    observeDevicePixelRatio();
  }

  function observeDevicePixelRatio() {
    if (!window.matchMedia) return;
    if (dprMediaQuery) {
      if (dprMediaQuery.removeEventListener) dprMediaQuery.removeEventListener('change', handleDevicePixelRatioChange);
      else if (dprMediaQuery.removeListener) dprMediaQuery.removeListener(handleDevicePixelRatioChange);
    }
    dprMediaQuery = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)');
    if (dprMediaQuery.addEventListener) dprMediaQuery.addEventListener('change', handleDevicePixelRatioChange, { once: true });
    else if (dprMediaQuery.addListener) dprMediaQuery.addListener(handleDevicePixelRatioChange);
  }

  function setRnViewport(width, height, dpr) {
    if (!(width > 0) || !(height > 0)) return;
    rnViewport = { width: width, height: height };
    if (typeof dpr === 'number' && dpr > 0 && Math.abs(dpr - rnDpr) > 0.001) {
      rnDpr = dpr;
      handleDevicePixelRatioChange();
    }
    applyFitScale('rn-viewport');
    clampPan();
    updateTransform();
    notifyViewportChanged();
  }

  observeDevicePixelRatio();
`
