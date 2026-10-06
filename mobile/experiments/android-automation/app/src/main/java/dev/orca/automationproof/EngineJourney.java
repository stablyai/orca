package dev.orca.automationproof;

import android.util.Base64;
import java.io.File;
import java.nio.file.Files;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

final class EngineJourney {
    static void run(EngineCdp cdp, JSONObject evidence, File directory) throws Exception {
        cdp.command("Page.enable");
        cdp.command("Accessibility.enable");
        JSONObject ax = cdp.command("Accessibility.getFullAXTree");
        Files.write(new File(directory, "ax-tree.json").toPath(), ax.toString(2).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        evidence.put("axNodeCount", ax.getJSONArray("nodes").length());
        evidence.put("customerSelector", select(cdp, "#customer"));
        click(cdp, "#customer");
        cdp.command("Input.insertText", new JSONObject().put("text", "Orca agent 한글"));
        click(cdp, "#submit");
        await(cdp, "document.getElementById('status').textContent === 'Ordered for Orca agent 한글'");
        evidence.put("interaction", cdp.evaluate("({value:customer.value,status:document.getElementById('status').textContent,events})"));
        try {
            String image = cdp.command("Page.captureScreenshot", new JSONObject().put("format", "png")).getString("data");
            byte[] png = Base64.decode(image, Base64.DEFAULT);
            Files.write(new File(directory, "cdp-screenshot.png").toPath(), png);
            evidence.put("screenshotBytes", png.length);
        } catch (Exception error) { evidence.put("screenshotFailure", error.toString()); }
        click(cdp, "#next");
        await(cdp, "document.title === 'Second page'");
        evidence.put("trustedLinkNavigation", cdp.evaluate("location.href"));
        cdp.command("Page.navigate", new JSONObject().put("url", "file:///android_asset/page.html?cdp=1"));
        await(cdp, "document.title === 'Android engine automation proof'");
        evidence.put("pageNavigate", cdp.evaluate("location.href"));
    }

    private static int select(EngineCdp cdp, String selector) throws Exception {
        int root = cdp.command("DOM.getDocument").getJSONObject("root").getInt("nodeId");
        int node = cdp.command("DOM.querySelector", new JSONObject().put("nodeId", root).put("selector", selector)).getInt("nodeId");
        if (node == 0) throw new IllegalStateException("selector missing: " + selector);
        return node;
    }

    private static void click(EngineCdp cdp, String selector) throws Exception {
        int node = select(cdp, selector);
        cdp.command("DOM.scrollIntoViewIfNeeded", new JSONObject().put("nodeId", node));
        JSONArray quad = cdp.command("DOM.getBoxModel", new JSONObject().put("nodeId", node)).getJSONObject("model").getJSONArray("content");
        double x = (quad.getDouble(0) + quad.getDouble(4)) / 2;
        double y = (quad.getDouble(1) + quad.getDouble(5)) / 2;
        cdp.command("Input.dispatchMouseEvent", new JSONObject().put("type", "mousePressed").put("x", x).put("y", y).put("button", "left").put("clickCount", 1));
        cdp.command("Input.dispatchMouseEvent", new JSONObject().put("type", "mouseReleased").put("x", x).put("y", y).put("button", "left").put("clickCount", 1));
    }

    private static void await(EngineCdp cdp, String expression) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < deadline) {
            if (Boolean.TRUE.equals(cdp.evaluate(expression))) return;
            Thread.sleep(50);
        }
        throw new IllegalStateException("condition timed out: " + expression);
    }
}
